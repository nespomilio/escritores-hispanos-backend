// server.js
// Backend mínimo para Escritores Hispanos — Director Editorial
// Hace de intermediario entre la app (navegador) y la API de Claude,
// para que la clave de API nunca quede expuesta en el navegador.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iyhdldixxpxzhudcswty.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || 'cambia-esto';

if (!ANTHROPIC_API_KEY) {
  console.error('\n⚠️  Falta la variable de entorno ANTHROPIC_API_KEY.');
  console.error('   Antes de arrancar, corre (en la misma terminal):');
  console.error('   Windows (PowerShell):  $env:ANTHROPIC_API_KEY="sk-ant-tu-clave-aqui"');
  console.error('   Windows (cmd):         set ANTHROPIC_API_KEY=sk-ant-tu-clave-aqui');
  console.error('   Mac/Linux:              export ANTHROPIC_API_KEY="sk-ant-tu-clave-aqui"\n');
}
if (!OPENAI_API_KEY) {
  console.error('\n⚠️  Falta la variable de entorno OPENAI_API_KEY (necesaria solo para generar portadas).');
  console.error('   Windows (cmd):  set OPENAI_API_KEY=sk-tu-clave-de-openai-aqui\n');
}
if (!STRIPE_SECRET_KEY) {
  console.error('\n⚠️  Falta la variable de entorno STRIPE_SECRET_KEY (necesaria para cobrar suscripciones).');
  console.error('   Windows (cmd):  set STRIPE_SECRET_KEY=sk_test_tu-clave-de-stripe-aqui\n');
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('\n⚠️  Falta la variable de entorno SUPABASE_SERVICE_KEY (necesaria para que el backend actualice planes).');
  console.error('   Windows (cmd):  set SUPABASE_SERVICE_KEY=tu-service-role-key-aqui\n');
}
if (!RESEND_API_KEY) {
  console.error('\n⚠️  Falta la variable de entorno RESEND_API_KEY (necesaria solo para los correos de recordatorio).');
  console.error('   Windows (cmd):  set RESEND_API_KEY=re_tu-clave-aqui\n');
}

const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Error de la API de Anthropic:', data);
      return res.status(response.status).json({ error: data });
    }

    res.json(data);
  } catch (err) {
    console.error('Error en /api/chat:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/imagen', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(400).json({ error: 'Falta OPENAI_API_KEY en el servidor. Revisa la terminal del backend.' });
    }
    const { prompt, size } = req.body;

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        size: size || '1024x1536',
        n: 1
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Error de la API de OpenAI:', data);
      return res.status(response.status).json({ error: data });
    }

    res.json(data);
  } catch (err) {
    console.error('Error en /api/imagen:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/crear-checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Falta STRIPE_SECRET_KEY en el servidor.' });
    const { priceId, plan, usuarioId, email, returnUrl } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: `${returnUrl}?pago=exito&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}?pago=cancelado`,
      metadata: { usuario_id: usuarioId, plan }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error en /api/crear-checkout:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/verificar-pago', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Falta STRIPE_SECRET_KEY en el servidor.' });
    if (!supabaseAdmin) return res.status(400).json({ error: 'Falta SUPABASE_SERVICE_KEY en el servidor.' });

    const { session_id } = req.query;
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.json({ ok: false, mensaje: 'El pago aún no se completó.' });
    }

    const { usuario_id, plan } = session.metadata;
    const { error } = await supabaseAdmin
      .from('eh_perfiles')
      .update({ plan, stripe_customer_id: session.customer })
      .eq('id', usuario_id);

    if (error) throw error;

    res.json({ ok: true, plan });
  } catch (err) {
    console.error('Error en /api/verificar-pago:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin-stats', async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(400).json({ error: 'Falta SUPABASE_SERVICE_KEY en el servidor.' });
    const { usuarioId } = req.body;

    // Verifica que quien pide esto sea realmente el administrador
    const { data: perfil, error: errPerfil } = await supabaseAdmin
      .from('eh_perfiles').select('es_admin').eq('id', usuarioId).single();
    if (errPerfil || !perfil || !perfil.es_admin) {
      return res.status(403).json({ error: 'No autorizado.' });
    }

    // ---- Datos de Supabase ----
    const { data: perfiles } = await supabaseAdmin.from('eh_perfiles').select('plan, created_at');
    const { data: proyectos } = await supabaseAdmin.from('eh_proyectos').select('id, created_at');
    const { data: eventos } = await supabaseAdmin.from('eh_eventos_uso').select('herramienta, palabras, creado_en');

    const usuariosPorPlan = { gratis: 0, pro: 0, premium: 0 };
    (perfiles || []).forEach(p => { usuariosPorPlan[p.plan || 'gratis'] = (usuariosPorPlan[p.plan || 'gratis'] || 0) + 1; });

    const usoPorHerramienta = {};
    (eventos || []).forEach(e => {
      usoPorHerramienta[e.herramienta] = (usoPorHerramienta[e.herramienta] || 0) + 1;
    });

    const hace30dias = new Date(Date.now() - 30*24*60*60*1000).toISOString();
    const altasUltimos30 = (perfiles || []).filter(p => p.created_at > hace30dias).length;

    // ---- Datos de Stripe (suscripciones activas + ingreso mensual estimado) ----
    let stripeStats = { suscripciones_activas: 0, mrr_estimado: 0 };
    if (stripe) {
      const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
      stripeStats.suscripciones_activas = subs.data.length;
      stripeStats.mrr_estimado = subs.data.reduce((sum, s) => {
        const item = s.items.data[0];
        const monto = item?.price?.unit_amount || 0;
        return sum + (monto / 100);
      }, 0);
    }

    res.json({
      total_usuarios: (perfiles || []).length,
      usuarios_por_plan: usuariosPorPlan,
      altas_ultimos_30_dias: altasUltimos30,
      total_proyectos: (proyectos || []).length,
      uso_por_herramienta: usoPorHerramienta,
      stripe: stripeStats
    });
  } catch (err) {
    console.error('Error en /api/admin-stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/audio', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ error: 'Falta OPENAI_API_KEY en el servidor.' });
    const { texto, voz } = req.body;

    if (!texto || texto.length > 4096) {
      return res.status(400).json({ error: 'El texto está vacío o supera los 4.096 caracteres permitidos por OpenAI. Prueba con un capítulo más corto.' });
    }

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: voz || 'nova',
        input: texto,
        response_format: 'mp3'
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Error de la API de OpenAI (audio):', errData);
      return res.status(response.status).json({ error: errData.error?.message || 'Error generando audio' });
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    res.json({ audio_base64: base64 });
  } catch (err) {
    console.error('Error en /api/audio:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/enviar-recordatorios', async (req, res) => {
  try {
    if (req.query.secreto !== CRON_SECRET) {
      return res.status(403).json({ error: 'No autorizado.' });
    }
    if (!supabaseAdmin) return res.status(400).json({ error: 'Falta SUPABASE_SERVICE_KEY.' });
    if (!RESEND_API_KEY) return res.status(400).json({ error: 'Falta RESEND_API_KEY.' });

    const hace3dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const hace4dias = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Usuarios inactivos entre 3 y 4 días, a quienes no se les mandó recordatorio en los últimos 7 días
    const { data: usuarios, error } = await supabaseAdmin
      .from('eh_perfiles')
      .select('id, nombre, ultima_actividad, ultimo_recordatorio_enviado')
      .lt('ultima_actividad', hace3dias)
      .gt('ultima_actividad', hace4dias);

    if (error) throw error;

    const aEnviar = (usuarios || []).filter(u =>
      !u.ultimo_recordatorio_enviado || u.ultimo_recordatorio_enviado < hace7dias
    );

    let enviados = 0;
    for (const usuario of aEnviar) {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(usuario.id);
      const email = authUser?.user?.email;
      if (!email) continue;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'LibroOS <onboarding@resend.dev>',
          to: email,
          subject: 'Tu libro te está esperando',
          html: `<div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
            <h2 style="color:#16302e;">¿Seguimos con tu libro?</h2>
            <p>Han pasado unos días desde tu última visita a LibroOS. Tu proyecto sigue tal como lo dejaste, listo para continuar cuando quieras.</p>
            <a href="https://app.escritoreshispanos.com/director-editorial-app.html" style="display:inline-block; background:#d9ae57; color:#20140a; padding:12px 24px; border-radius:24px; text-decoration:none; font-weight:bold; margin-top:12px;">Continuar escribiendo →</a>
          </div>`
        })
      });

      await supabaseAdmin.from('eh_perfiles').update({ ultimo_recordatorio_enviado: new Date().toISOString() }).eq('id', usuario.id);
      enviados++;
    }

    res.json({ ok: true, revisados: (usuarios || []).length, enviados });
  } catch (err) {
    console.error('Error en /api/enviar-recordatorios:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Backend de Escritores Hispanos corriendo en http://localhost:${PORT}`);
  console.log(`   La app debe llamar a http://localhost:${PORT}/api/chat\n`);
});

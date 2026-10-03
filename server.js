// server.js
// Backend mínimo para Escritores Hispanos — Director Editorial
// Hace de intermediario entre la app (navegador) y la API de Claude,
// para que la clave de API nunca quede expuesta en el navegador.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
// Stripe necesita el cuerpo sin procesar para comprobar la firma: esta ruta va antes de express.json
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => manejarWebhookStripe(req, res));
app.use(express.json({ limit: '20mb' }));

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

// ================= SEGURIDAD =================
// Solo usuarios con sesión iniciada en LibroOS pueden usar las rutas que gastan dinero (IA, pagos).
// El plan se lee de la base de datos, nunca de lo que envía el navegador.
const LIMITES_PLAN = { gratis: 3000, pro: 150000, premium: Infinity };
const PRICE_IDS = {
  pro: process.env.STRIPE_PRICE_PRO || 'price_1Tx5xR56RMKsYdNnBIM07lY0',
  premium: process.env.STRIPE_PRICE_PREMIUM || 'price_1Tx5yc56RMKsYdNnKj4OnwZk'
};
const DIAS_PRUEBA = parseInt(process.env.DIAS_PRUEBA || '7', 10);

async function requiereUsuario(req, res, next) {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_KEY en el servidor.' });
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Tu sesión ha caducado. Recarga la página e inicia sesión de nuevo.' });
    req.usuario = data.user;
    const { data: perfil } = await supabaseAdmin
      .from('eh_perfiles')
      .select('plan, es_admin, palabras_usadas_mes, mes_actual, stripe_customer_id')
      .eq('id', data.user.id)
      .maybeSingle();
    req.perfil = perfil || { plan: 'gratis', es_admin: false, palabras_usadas_mes: 0, mes_actual: null };
    next();
  } catch (err) {
    console.error('Error verificando usuario:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

function soloPremium(req, res, next) {
  if (req.perfil.plan !== 'premium') {
    return res.status(403).json({ error: 'Esta función es exclusiva del plan Autor Premium.' });
  }
  next();
}

function dentroDelLimite(req, res, next) {
  const limite = LIMITES_PLAN[req.perfil.plan] ?? LIMITES_PLAN.gratis;
  const mesHoy = new Date().toISOString().slice(0, 7);
  const usadas = req.perfil.mes_actual === mesHoy ? (req.perfil.palabras_usadas_mes || 0) : 0;
  if (usadas >= limite) {
    return res.status(402).json({ error: 'Has alcanzado el límite de palabras de tu plan este mes. Mejora tu plan para seguir escribiendo.' });
  }
  next();
}
// =============================================

app.post('/api/chat', requiereUsuario, dentroDelLimite, async (req, res) => {
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
        max_tokens: 8192,
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

app.post('/api/imagen', requiereUsuario, soloPremium, async (req, res) => {
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

app.post('/api/crear-checkout', requiereUsuario, async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Falta STRIPE_SECRET_KEY en el servidor.' });
    const { plan, returnUrl } = req.body;
    const priceId = PRICE_IDS[plan];
    if (!priceId) return res.status(400).json({ error: 'Plan no válido.' });
    const urlVuelta = (typeof returnUrl === 'string' && returnUrl.startsWith('https://')) ? returnUrl : 'https://app.escritoreshispanos.com/director-editorial-app.html';

    // Si ya paga un plan, se cambia desde el portal de Stripe (así no se cobran dos suscripciones)
    if (req.perfil.plan !== 'gratis' && req.perfil.stripe_customer_id) {
      const portal = await stripe.billingPortal.sessions.create({ customer: req.perfil.stripe_customer_id, return_url: urlVuelta });
      return res.json({ url: portal.url });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      ...(req.perfil.stripe_customer_id ? { customer: req.perfil.stripe_customer_id } : { customer_email: req.usuario.email }),
      ...(DIAS_PRUEBA > 0 ? { subscription_data: { trial_period_days: DIAS_PRUEBA } } : {}),
      success_url: `${urlVuelta}?pago=exito&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${urlVuelta}?pago=cancelado`,
      metadata: { usuario_id: req.usuario.id, plan }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error en /api/crear-checkout:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================= SUSCRIPCIONES =================
// Portal de Stripe: el usuario cancela, cambia de plan o actualiza su tarjeta
app.post('/api/portal-cliente', requiereUsuario, async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Falta STRIPE_SECRET_KEY en el servidor.' });
    if (!req.perfil.stripe_customer_id) return res.status(400).json({ error: 'No tienes ninguna suscripción de pago.' });
    const { returnUrl } = req.body || {};
    const urlVuelta = (typeof returnUrl === 'string' && returnUrl.startsWith('https://')) ? returnUrl : 'https://app.escritoreshispanos.com/director-editorial-app.html';
    const portal = await stripe.billingPortal.sessions.create({ customer: req.perfil.stripe_customer_id, return_url: urlVuelta });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('Error en /api/portal-cliente:', err.message);
    res.status(500).json({ error: 'No se pudo abrir la gestión de la suscripción.' });
  }
});

// El mejor plan que tiene activo un cliente en Stripe (activo, en prueba o con un cobro reintentándose)
async function planSegunStripe(customerId) {
  const rango = { gratis: 0, pro: 1, premium: 2 };
  let mejor = 'gratis';
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  for (const s of subs.data) {
    if (!['active', 'trialing', 'past_due'].includes(s.status)) continue;
    for (const item of s.items.data) {
      const plan = Object.keys(PRICE_IDS).find(k => PRICE_IDS[k] === item.price.id);
      if (plan && rango[plan] > rango[mejor]) mejor = plan;
    }
  }
  return mejor;
}

// Avisos automáticos de Stripe: pagos, cambios de plan, cancelaciones y fin de la prueba
async function manejarWebhookStripe(req, res) {
  if (!stripe || !supabaseAdmin) return res.status(500).send('Servidor sin configurar');
  const secreto = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secreto) return res.status(500).send('Falta STRIPE_WEBHOOK_SECRET');
  let evento;
  try {
    evento = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secreto);
  } catch (err) {
    console.error('Webhook de Stripe con firma no válida:', err.message);
    return res.status(400).send('Firma no válida');
  }
  try {
    const obj = evento.data.object;
    if (evento.type === 'checkout.session.completed') {
      // Respaldo por si el usuario cierra la pestaña antes de volver a LibroOS
      const { usuario_id, plan } = obj.metadata || {};
      if (usuario_id && PRICE_IDS[plan] && obj.customer) {
        await supabaseAdmin.from('eh_perfiles').update({ plan, stripe_customer_id: obj.customer }).eq('id', usuario_id);
      }
    } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(evento.type)) {
      const plan = await planSegunStripe(obj.customer);
      await supabaseAdmin.from('eh_perfiles').update({ plan }).eq('stripe_customer_id', obj.customer);
      console.log(`Stripe ${evento.type}: cliente ${obj.customer} queda en plan ${plan}`);
    }
    res.json({ recibido: true });
  } catch (err) {
    console.error('Error procesando webhook de Stripe:', err);
    res.status(500).send('Error');
  }
}
// =================================================

app.get('/api/verificar-pago', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Falta STRIPE_SECRET_KEY en el servidor.' });
    if (!supabaseAdmin) return res.status(400).json({ error: 'Falta SUPABASE_SERVICE_KEY en el servidor.' });

    const { session_id } = req.query;
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const pagoOk = session.status === 'complete' &&
      (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
    if (!pagoOk) {
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

app.get('/api/ping', async (req, res) => {
  try {
    if (supabaseAdmin) {
      await supabaseAdmin.from('eh_perfiles').select('id').limit(1);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

app.post('/api/admin-stats', requiereUsuario, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(400).json({ error: 'Falta SUPABASE_SERVICE_KEY en el servidor.' });
    if (!req.perfil.es_admin) {
      return res.status(403).json({ error: 'No autorizado.' });
    }

    // ---- Datos base de Supabase ----
    const { data: perfiles } = await supabaseAdmin.from('eh_perfiles').select('id, plan, created_at, ultima_actividad');
    const { data: proyectos } = await supabaseAdmin.from('eh_proyectos').select('id, created_at');
    const { data: eventos } = await supabaseAdmin.from('eh_eventos_uso').select('usuario_id, herramienta, palabras, creado_en');

    const usuariosPorPlan = { gratis: 0, pro: 0, premium: 0 };
    (perfiles || []).forEach(p => { usuariosPorPlan[p.plan || 'gratis'] = (usuariosPorPlan[p.plan || 'gratis'] || 0) + 1; });

    const usoPorHerramienta = {};
    (eventos || []).forEach(e => {
      usoPorHerramienta[e.herramienta] = (usoPorHerramienta[e.herramienta] || 0) + 1;
    });

    const ahora = Date.now();
    const hace30dias = new Date(ahora - 30*24*60*60*1000).toISOString();
    const hace7dias = new Date(ahora - 7*24*60*60*1000).toISOString();
    const altasUltimos30 = (perfiles || []).filter(p => p.created_at > hace30dias).length;

    // ---- Funnel de conversión ----
    const totalUsuarios = (perfiles || []).length;
    const usuariosDePago = usuariosPorPlan.pro + usuariosPorPlan.premium;
    const tasaConversion = totalUsuarios > 0 ? (usuariosDePago / totalUsuarios) * 100 : 0;

    // ---- Retención (usuarios distintos con actividad reciente) ----
    const idsActivos7 = new Set((eventos || []).filter(e => e.creado_en > hace7dias).map(e => e.usuario_id));
    const idsActivos30 = new Set((eventos || []).filter(e => e.creado_en > hace30dias).map(e => e.usuario_id));

    // ---- Palabras generadas por IA (total histórico) ----
    const palabrasGeneradasTotal = (eventos || []).reduce((sum, e) => sum + (e.palabras || 0), 0);

    // ---- Datos de Stripe: suscripciones activas, MRR, churn, ingreso acumulado ----
    let stripeStats = {
      suscripciones_activas: 0,
      mrr_estimado: 0,
      canceladas_ultimos_30_dias: 0,
      canceladas_total: 0,
      ingreso_acumulado: 0
    };
    if (stripe) {
      const subsActivas = await stripe.subscriptions.list({ status: 'active', limit: 100 });
      stripeStats.suscripciones_activas = subsActivas.data.length;
      stripeStats.mrr_estimado = subsActivas.data.reduce((sum, s) => {
        const item = s.items.data[0];
        const monto = item?.price?.unit_amount || 0;
        return sum + (monto / 100);
      }, 0);

      const subsCanceladas = await stripe.subscriptions.list({ status: 'canceled', limit: 100 });
      stripeStats.canceladas_total = subsCanceladas.data.length;
      const hace30segundos = Math.floor((ahora - 30*24*60*60*1000) / 1000);
      stripeStats.canceladas_ultimos_30_dias = subsCanceladas.data.filter(s => s.canceled_at && s.canceled_at > hace30segundos).length;

      const facturas = await stripe.invoices.list({ status: 'paid', limit: 100 });
      stripeStats.ingreso_acumulado = facturas.data.reduce((sum, f) => sum + (f.amount_paid / 100), 0);
    }

    // ---- Lista de usuarios individuales (con email) ----
    let listaUsuarios = [];
    try {
      const { data: authData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      const emailsPorId = {};
      (authData?.users || []).forEach(u => { emailsPorId[u.id] = u.email; });
      listaUsuarios = (perfiles || []).map(p => ({
        email: emailsPorId[p.id] || '(sin email)',
        plan: p.plan || 'gratis',
        alta: p.created_at,
        ultima_actividad: p.ultima_actividad || null
      })).sort((a, b) => new Date(b.alta) - new Date(a.alta));
    } catch (e) {
      console.error('Error listando usuarios:', e.message);
    }

    res.json({
      total_usuarios: totalUsuarios,
      usuarios_por_plan: usuariosPorPlan,
      altas_ultimos_30_dias: altasUltimos30,
      total_proyectos: (proyectos || []).length,
      uso_por_herramienta: usoPorHerramienta,
      stripe: stripeStats,
      funnel: {
        total: totalUsuarios,
        usuarios_de_pago: usuariosDePago,
        tasa_conversion: tasaConversion
      },
      retencion: {
        activos_7_dias: idsActivos7.size,
        activos_30_dias: idsActivos30.size
      },
      palabras_generadas_total: palabrasGeneradasTotal,
      lista_usuarios: listaUsuarios
    });
  } catch (err) {
    console.error('Error en /api/admin-stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transcribir', requiereUsuario, soloPremium, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ error: 'Falta OPENAI_API_KEY en el servidor.' });
    const { audio_base64, mime_type } = req.body;
    if (!audio_base64) return res.status(400).json({ error: 'No llegó ningún audio.' });

    const buffer = Buffer.from(audio_base64, 'base64');
    const blob = new Blob([buffer], { type: mime_type || 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, 'dictado.webm');
    formData.append('model', 'gpt-4o-transcribe');
    formData.append('language', 'es');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Error de la API de OpenAI (transcripción):', data);
      return res.status(response.status).json({ error: data.error?.message || 'Error transcribiendo audio' });
    }

    res.json({ texto: data.text });
  } catch (err) {
    console.error('Error en /api/transcribir:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/audio', requiereUsuario, soloPremium, async (req, res) => {
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
          from: process.env.EMAIL_REMITENTE || 'LibroOS <info@escritoreshispanos.com>',
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

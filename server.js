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
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iyhdldixxpzxhudcswty.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Backend de Escritores Hispanos corriendo en http://localhost:${PORT}`);
  console.log(`   La app debe llamar a http://localhost:${PORT}/api/chat\n`);
});

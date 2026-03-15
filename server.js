require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Base de datos
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── ENVIAR WHATSAPP VIA CALLMEBOT ──────────────────
async function enviarWhatsApp(mensaje) {
  const phone  = process.env.CALLMEBOT_PHONE;  // ej: 5492374108118
  const apikey = process.env.CALLMEBOT_APIKEY; // ej: 2895127
  const texto  = encodeURIComponent(mensaje);
  const url    = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${texto}&apikey=${apikey}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`CallMeBot error: ${r.status}`);
  console.log('✅ WhatsApp enviado');
}

// ── INICIALIZAR TABLAS ─────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre TEXT NOT NULL,
      direccion TEXT NOT NULL,
      numero_emergencia TEXT NOT NULL,
      device_id TEXT UNIQUE NOT NULL,
      tipo TEXT DEFAULT 'alarma',
      ultimo_heartbeat TIMESTAMP,
      activo BOOLEAN DEFAULT true,
      creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS eventos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      detalle TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'alarma';
  `);

  console.log('✅ Base de datos lista');
}

// ── HEARTBEAT ──────────────────────────────────────
app.post('/api/heartbeat', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requerido' });

  await db.query(
    'UPDATE clientes SET ultimo_heartbeat = NOW() WHERE device_id = $1',
    [device_id]
  );
  res.json({ ok: true });
});

// ── ALARMA ─────────────────────────────────────────
app.post('/api/alarma', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requerido' });

  const result = await db.query(
    'SELECT * FROM clientes WHERE device_id = $1 AND activo = true',
    [device_id]
  );

  if (result.rows.length === 0)
    return res.status(404).json({ error: 'Dispositivo no registrado' });

  const cliente = result.rows[0];

  await db.query(
    'INSERT INTO eventos (device_id, tipo, detalle) VALUES ($1, $2, $3)',
    [device_id, 'ALARMA', `Alarma activada en ${cliente.direccion}`]
  );

  const mensaje = `🚨 ALERTA DE SEGURIDAD\n\nSe activó la alarma en:\n📍 ${cliente.direccion}\n👤 ${cliente.nombre}\n📞 ${cliente.numero_emergencia}\n\n⚠️ Por favor enviar una unidad.`;

  try {
    await enviarWhatsApp(mensaje);
    console.log(`🚨 Alarma procesada para ${cliente.nombre}`);
    res.json({ ok: true, mensaje: 'Alerta WhatsApp enviada' });
  } catch (err) {
    console.error('Error CallMeBot:', err.message);
    res.status(500).json({ error: 'Error al enviar alerta: ' + err.message });
  }
});

// ── BOTÓN DE PÁNICO ────────────────────────────────
app.post('/api/panico', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requerido' });

  const result = await db.query(
    'SELECT * FROM clientes WHERE device_id = $1 AND activo = true',
    [device_id]
  );

  if (result.rows.length === 0)
    return res.status(404).json({ error: 'Dispositivo no registrado' });

  const cliente = result.rows[0];

  await db.query(
    'INSERT INTO eventos (device_id, tipo, detalle) VALUES ($1, $2, $3)',
    [device_id, 'PANICO', `Botón de pánico activado por ${cliente.nombre}`]
  );

  const mensaje = `🆘 EMERGENCIA PERSONAL\n\n${cliente.nombre} necesita ayuda urgente!\n📍 ${cliente.direccion}\n📞 ${cliente.numero_emergencia}\n\n⚠️ Contactar inmediatamente.`;

  try {
    await enviarWhatsApp(mensaje);
    console.log(`🆘 Pánico activado por ${cliente.nombre}`);
    res.json({ ok: true, mensaje: 'Alerta WhatsApp enviada' });
  } catch (err) {
    console.error('Error CallMeBot:', err.message);
    res.status(500).json({ error: 'Error al enviar alerta: ' + err.message });
  }
});

// ── PANEL ADMIN — listar clientes ──────────────────
app.get('/api/admin/clientes', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'No autorizado' });

  const result = await db.query(`
    SELECT 
      id, nombre, direccion, numero_emergencia, device_id, tipo, activo,
      ultimo_heartbeat,
      CASE 
        WHEN ultimo_heartbeat > NOW() - INTERVAL '10 minutes' THEN 'online'
        ELSE 'offline'
      END AS estado
    FROM clientes 
    ORDER BY creado_en DESC
  `);
  res.json(result.rows);
});

// ── PANEL ADMIN — historial de eventos ────────────
app.get('/api/admin/eventos', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'No autorizado' });

  const result = await db.query(`
    SELECT e.*, c.nombre, c.direccion 
    FROM eventos e
    LEFT JOIN clientes c ON e.device_id = c.device_id
    ORDER BY e.creado_en DESC 
    LIMIT 100
  `);
  res.json(result.rows);
});

// ── PANEL ADMIN — agregar cliente ─────────────────
app.post('/api/admin/clientes', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'No autorizado' });

  const { nombre, direccion, numero_emergencia, tipo = 'alarma' } = req.body;

  if (!nombre || !direccion || !numero_emergencia)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  const device_id = uuidv4();

  try {
    await db.query(
      'INSERT INTO clientes (nombre, direccion, numero_emergencia, device_id, tipo) VALUES ($1,$2,$3,$4,$5)',
      [nombre, direccion, numero_emergencia, device_id, tipo]
    );
    res.json({ ok: true, device_id, mensaje: 'Cliente creado. Grabar device_id en el ESP32.' });
  } catch (err) {
    console.error('Error al crear cliente:', err.message);
    res.status(500).json({ error: 'Error al guardar: ' + err.message });
  }
});

// ── PANEL ADMIN — actualizar cliente ──────────────
app.put('/api/admin/clientes/:device_id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'No autorizado' });

  const { numero_emergencia, nombre, direccion } = req.body;
  await db.query(
    'UPDATE clientes SET numero_emergencia=$1, nombre=$2, direccion=$3 WHERE device_id=$4',
    [numero_emergencia, nombre, direccion, req.params.device_id]
  );
  res.json({ ok: true });
});

// ── ARRANCAR ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
});

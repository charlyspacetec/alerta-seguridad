require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Base de datos
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Twilio
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// ── INICIALIZAR TABLAS ─────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre TEXT NOT NULL,
      direccion TEXT NOT NULL,
      numero_emergencia TEXT NOT NULL,
      device_id TEXT UNIQUE NOT NULL,
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
  console.log('✅ Base de datos lista');
}

// ── HEARTBEAT (ESP32 avisa que sigue online) ───────
app.post('/api/heartbeat', async (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requerido' });

  await db.query(
    'UPDATE clientes SET ultimo_heartbeat = NOW() WHERE device_id = $1',
    [device_id]
  );
  res.json({ ok: true });
});

// ── ALARMA DISPARADA (ESP32 avisa que se activó) ───
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

  // Registrar evento
  await db.query(
    'INSERT INTO eventos (device_id, tipo, detalle) VALUES ($1, $2, $3)',
    [device_id, 'ALARMA', `Alarma activada en ${cliente.direccion}`]
  );

  // Mensaje de voz
  const msgVoz = `Atención. Alerta de seguridad. 
    Se activó la alarma en el domicilio ${cliente.direccion}. 
    Propietario: ${cliente.nombre}. 
    Por favor enviar una unidad. 
    Repito: ${cliente.direccion}.`;

  // Llamar al número de emergencia del cliente
  try {
    await twilioClient.calls.create({
      twiml: `<Response>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
                <Pause length="1"/>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
              </Response>`,
      to: cliente.numero_emergencia,
      from: process.env.TWILIO_FROM
    });

    // También llamar al número de la comisaría fija
    await twilioClient.calls.create({
      twiml: `<Response>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
                <Pause length="1"/>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
              </Response>`,
      to: process.env.COMISARIA_DEFAULT,
      from: process.env.TWILIO_FROM
    });

    console.log(`🚨 Alarma procesada para ${cliente.nombre}`);
    res.json({ ok: true, mensaje: 'Llamadas enviadas' });

  } catch (err) {
    console.error('Error Twilio:', err.message);
    res.status(500).json({ error: 'Error al realizar llamada' });
  }
});

// ── PANEL ADMIN — listar clientes ──────────────────
app.get('/api/admin/clientes', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'No autorizado' });

  const result = await db.query(`
    SELECT 
      id, nombre, direccion, numero_emergencia, device_id, activo,
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

  const { nombre, direccion, numero_emergencia } = req.body;
  const device_id = uuidv4(); // ID único para el ESP32

  await db.query(
    'INSERT INTO clientes (nombre, direccion, numero_emergencia, device_id) VALUES ($1,$2,$3,$4)',
    [nombre, direccion, numero_emergencia, device_id]
  );

  res.json({ ok: true, device_id, mensaje: 'Cliente creado. Grabar device_id en el ESP32.' });
});

// ── PANEL ADMIN — actualizar número emergencia ────
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
// ── BOTÓN DE PÁNICO ───────────────────────────────
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

  const msgVoz = `Atención. Alerta de emergencia personal. 
    ${cliente.nombre} necesita ayuda urgente. 
    Domicilio: ${cliente.direccion}. 
    Contactar inmediatamente. 
    Repito: ${cliente.nombre} en ${cliente.direccion} necesita ayuda.`;

  try {
    // Llamar al familiar
    await twilioClient.calls.create({
      twiml: `<Response>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
                <Pause length="1"/>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
              </Response>`,
      to: cliente.numero_emergencia,
      from: process.env.TWILIO_FROM
    });

    // Llamar también al número de emergencias configurado
    await twilioClient.calls.create({
      twiml: `<Response>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
                <Pause length="1"/>
                <Say language="es-MX" voice="Polly.Conchita">${msgVoz}</Say>
              </Response>`,
      to: cliente.numero_emergencia,
      from: process.env.TWILIO_FROM
    });

    console.log(`🆘 Pánico activado por ${cliente.nombre}`);
    res.json({ ok: true, mensaje: 'Llamadas de emergencia enviadas' });

  } catch (err) {
    console.error('Error Twilio:', err.message);
    res.status(500).json({ error: 'Error al realizar llamada' });
  }
});

// ── ARRANCAR ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
});

/**
 * Microservicio MsMatriculas
 *
 * Este microservicio maneja toda la lógica específica para:
 * 1. Consultar si un estudiante ya existe por su RUT (insensible a formato).
 * 2. Recuperar la información del apoderado asociado en la tabla 'apoderado_estudiante'.
 * 3. Procesar y guardar la matrícula (crear/actualizar estudiante, crear/actualizar apoderado y asociarlos).
 * 4. Integración con Webpay Plus (Transbank) para cobrar la matrícula antes de registrarla.
 */

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DB_URL || 'postgresql://postgres:PossGAdmin#secure-key@db:5432/colegio'
});

// ─────────────────────────────────────────────
// Configuración de Webpay Plus (Transbank)
// En entorno de prueba (integración) usamos las credenciales de sandbox de Transbank.
// En producción, se deben proveer vía variables de entorno.
// ─────────────────────────────────────────────
const { WebpayPlus, Environment } = require('transbank-sdk');

// Credenciales de Sandbox (integración) proporcionadas por Transbank
const SANDBOX_COMMERCE_CODE = '597020000540';
const SANDBOX_API_KEY = '579B5317441BB0C95557E069884D734E675C3104587E32BB15771A97491E12C2';

let webpay;
if (process.env.WEBPAY_COMMERCE_CODE && process.env.WEBPAY_API_KEY) {
  // Modo producción: credenciales reales vía variables de entorno
  webpay = new WebpayPlus.Transaction({
    commerceCode: process.env.WEBPAY_COMMERCE_CODE,
    apiKey: process.env.WEBPAY_API_KEY,
    environment: Environment.Production
  });
} else {
  // Modo integración/pruebas: credenciales de sandbox de Transbank
  webpay = new WebpayPlus.Transaction({
    commerceCode: SANDBOX_COMMERCE_CODE,
    apiKey: SANDBOX_API_KEY,
    environment: Environment.Integration
  });
}

// ─────────────────────────────────────────────
// POST /api/matriculas/webpay/create
// Crea una transacción en Webpay y devuelve la URL y token para redirigir al usuario.
// ─────────────────────────────────────────────
app.post('/api/matriculas/webpay/create', async (req, res) => {
  const { amount, returnUrl } = req.body;
  if (!amount || !returnUrl) {
    return res.status(400).json({ error: 'Faltan campos: amount y returnUrl son requeridos.' });
  }
  try {
    const orderId = `MAT-${Date.now()}`;
    const response = await webpay.create(orderId, orderId, amount, returnUrl);
    return res.json({ url: response.url, token: response.token });
  } catch (error) {
    console.error('Error al crear transacción Webpay:', error);
    return res.status(500).json({ error: 'Error al iniciar pago con Webpay.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/matriculas/estudiantes/:rut
// Busca un estudiante por RUT y retorna sus datos + apoderado asociado.
// ─────────────────────────────────────────────
app.get('/api/matriculas/estudiantes/:rut', async (req, res) => {
  try {
    const { rut } = req.params;
    const cleanRut = rut.replace(/[^0-9kK]/g, '').toLowerCase();

    const query = `
      SELECT 
        e.estudiante_id,
        e.curso_id,
        u.rut as estudiante_rut,
        u.nombre as estudiante_nombre,
        u.apellido_paterno as estudiante_apellido_paterno,
        u.apellido_materno as estudiante_apellido_materno,
        u.email as estudiante_email,
        u.activo as estudiante_activo,
        ap.apoderado_id,
        apu.rut as apoderado_rut,
        apu.nombre as apoderado_nombre,
        apu.apellido_paterno as apoderado_apellido_paterno,
        apu.apellido_materno as apoderado_apellido_materno
      FROM estudiantes e
      JOIN usuarios u ON e.estudiante_id = u.usuario_id
      LEFT JOIN apoderado_estudiante ae ON e.estudiante_id = ae.estudiante_id
      LEFT JOIN apoderados ap ON ae.apoderado_id = ap.apoderado_id
      LEFT JOIN usuarios apu ON ap.apoderado_id = apu.usuario_id
      WHERE LOWER(REPLACE(REPLACE(u.rut, '.', ''), '-', '')) = $1;
    `;

    const result = await pool.query(query, [cleanRut]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Estudiante no registrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error en GET /api/matriculas/estudiantes/:rut:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────
// POST /api/matriculas
// Registra o actualiza la matrícula de un estudiante.
// Si se envía token_ws, primero confirma el pago con Webpay antes de guardar en BD.
// ─────────────────────────────────────────────
app.post('/api/matriculas', async (req, res) => {
  const client = await pool.connect();
  try {
    // Si se envía token_ws, validar la transacción con Webpay antes de guardar
    if (req.body.token_ws) {
      const commitResponse = await webpay.commit(req.body.token_ws);
      if (commitResponse.status !== 'AUTHORIZED') {
        return res.status(400).json({ error: 'Pago no autorizado por Webpay.' });
      }
    }

    await client.query('BEGIN');

    const {
      isNewStudent,
      nombreAlumno,
      apellidosAlumno,
      rutAlumno,
      curso: cursoId,
      nombreApoderado,
      rutApoderado
    } = req.body;

    const cleanRutAlumno = rutAlumno.trim();
    const cleanRutApoderado = rutApoderado.trim();

    // 1. PROCESAR ALUMNO
    const alumnoNombres = nombreAlumno.trim();
    const alumnoApellidos = apellidosAlumno.trim().split(/\s+/);
    const alumnoApePaterno = alumnoApellidos[0] || '';
    const alumnoApeMaterno = alumnoApellidos.slice(1).join(' ') || '';

    let estudianteId;

    if (isNewStudent) {
      const cleanString = (str) =>
        str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, '');
      const emailAlumno = `${cleanString(alumnoNombres)}.${cleanString(alumnoApePaterno)}@colegio.cl`;
      const defaultPass = '$2a$12$Iy8XTvbNC7Y.RWipf8O8f.vNU3VrVNC9m4Iq.02bPi.6pRbHYL66y';

      const insertUsuarioQuery = `
        INSERT INTO usuarios (rol_id, rut, nombre, apellido_paterno, apellido_materno, email, password, activo)
        VALUES (3, $1, $2, $3, $4, $5, $6, true)
        RETURNING usuario_id
      `;
      const resUsuario = await client.query(insertUsuarioQuery, [cleanRutAlumno, alumnoNombres, alumnoApePaterno, alumnoApeMaterno, emailAlumno, defaultPass]);
      estudianteId = resUsuario.rows[0].usuario_id;

      const insertEstudianteQuery = `
        INSERT INTO estudiantes (estudiante_id, curso_id)
        VALUES ($1, $2)
      `;
      await client.query(insertEstudianteQuery, [estudianteId, Number(cursoId)]);
    } else {
      const searchUserQuery = `SELECT usuario_id FROM usuarios WHERE rut = $1 LIMIT 1`;
      const searchRes = await client.query(searchUserQuery, [cleanRutAlumno]);
      if (searchRes.rows.length === 0) {
        throw new Error('Estudiante no encontrado en el sistema.');
      }
      estudianteId = searchRes.rows[0].usuario_id;

      const updateEstudianteQuery = `
        UPDATE estudiantes
        SET curso_id = $1
        WHERE estudiante_id = $2
      `;
      await client.query(updateEstudianteQuery, [Number(cursoId), estudianteId]);
    }

    // 2. PROCESAR APODERADO
    const apoApellidosList = nombreApoderado.trim().split(/\s+/);
    const apoNombre = apoApellidosList[0] || '';
    const apoApePaterno = apoApellidosList[1] || '';
    const apoApeMaterno = apoApellidosList.slice(2).join(' ') || '';

    const searchApoQuery = `SELECT usuario_id FROM usuarios WHERE rut = $1 LIMIT 1`;
    const searchApoRes = await client.query(searchApoQuery, [cleanRutApoderado]);

    let apoderadoId;
    if (searchApoRes.rows.length > 0) {
      apoderadoId = searchApoRes.rows[0].usuario_id;
      const updateApoUser = `
        UPDATE usuarios 
        SET nombre = $1, apellido_paterno = $2, apellido_materno = $3 
        WHERE usuario_id = $4
      `;
      await client.query(updateApoUser, [apoNombre, apoApePaterno, apoApeMaterno, apoderadoId]);
    } else {
      const cleanString = (str) =>
        str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, '');
      const emailApo = `${cleanString(apoNombre)}.${cleanString(apoApePaterno || 'apoderado')}@colegio.cl`;
      const defaultPass = '$2a$12$Iy8XTvbNC7Y.RWipf8O8f.vNU3VrVNC9m4Iq.02bPi.6pRbHYL66y';

      const insertApoUser = `
        INSERT INTO usuarios (rol_id, rut, nombre, apellido_paterno, apellido_materno, email, password, activo)
        VALUES (4, $1, $2, $3, $4, $5, $6, true)
        RETURNING usuario_id
      `;
      const resApoUser = await client.query(insertApoUser, [cleanRutApoderado, apoNombre, apoApePaterno, apoApeMaterno, emailApo, defaultPass]);
      apoderadoId = resApoUser.rows[0].usuario_id;
    }

    await client.query(`
      INSERT INTO apoderados (apoderado_id)
      VALUES ($1)
      ON CONFLICT (apoderado_id) DO NOTHING
    `, [apoderadoId]);

    await client.query(`DELETE FROM apoderado_estudiante WHERE estudiante_id = $1`, [estudianteId]);

    await client.query(`
      INSERT INTO apoderado_estudiante (apoderado_id, estudiante_id)
      VALUES ($1, $2)
    `, [apoderadoId, estudianteId]);

    await client.query('COMMIT');
    return res.json({ success: true, estudianteId, apoderadoId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar POST /api/matriculas:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`Servicio MsMatriculas ejecutándose en el puerto ${PORT}`);
});

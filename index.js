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

const { procesarMatricula } = require('./matriculas.service');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de Swagger
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MsMatriculas API',
      version: '1.0.0',
      description: 'Microservicio de Matrículas - API de integración',
    },
    servers: [
      {
        url: 'http://localhost:3003',
        description: 'Servidor Local (Directo)'
      },
      {
        url: 'http://localhost:81',
        description: 'Servidor Gateway'
      }
    ],
  },
  apis: ['./index.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DB_URL || 'postgresql://postgres:PossGAdmin#secure-key@db:5432/colegio',
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined
});

// ─────────────────────────────────────────────
// Configuración de Webpay Plus (Transbank)
// En entorno de prueba (integración) usamos las credenciales de sandbox de Transbank.
// En producción, se deben proveer vía variables de entorno.
// ─────────────────────────────────────────────
const { WebpayPlus, Environment, Options, IntegrationApiKeys, IntegrationCommerceCodes } = require('transbank-sdk');

let webpay;
if (process.env.WEBPAY_COMMERCE_CODE && process.env.WEBPAY_API_KEY) {
  // Modo producción: credenciales reales vía variables de entorno
  webpay = new WebpayPlus.Transaction(new Options(process.env.WEBPAY_COMMERCE_CODE, process.env.WEBPAY_API_KEY, Environment.Production));
} else {
  // Modo integración/pruebas: credenciales de sandbox de Transbank
  webpay = new WebpayPlus.Transaction(new Options(IntegrationCommerceCodes.WEBPAY_PLUS, IntegrationApiKeys.WEBPAY, Environment.Integration));
}

// ─────────────────────────────────────────────
// POST /api/matriculas/webpay/create
// Crea una transacción en Webpay y devuelve la URL y token para redirigir al usuario.
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/matriculas/webpay/create:
 *   post:
 *     summary: Crea una transacción en Webpay
 *     description: Retorna la URL y token para redirigir al usuario al pago.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount:
 *                 type: number
 *                 example: 35000
 *               returnUrl:
 *                 type: string
 *                 example: "http://localhost:4200/return"
 *     responses:
 *       200:
 *         description: Transacción creada exitosamente
 *       400:
 *         description: Faltan campos
 *       500:
 *         description: Error interno
 */
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
/**
 * @swagger
 * /api/matriculas/estudiantes/{rut}:
 *   get:
 *     summary: Obtiene estudiante y apoderado por RUT
 *     description: Busca un estudiante por RUT y retorna sus datos junto con el apoderado asociado.
 *     parameters:
 *       - in: path
 *         name: rut
 *         required: true
 *         schema:
 *           type: string
 *         description: RUT del estudiante
 *     responses:
 *       200:
 *         description: Datos obtenidos exitosamente
 *       404:
 *         description: Estudiante no encontrado
 *       500:
 *         description: Error interno
 */
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
/**
 * @swagger
 * /api/matriculas:
 *   post:
 *     summary: Registra o actualiza la matrícula
 *     description: Registra un estudiante y apoderado. Si trae token_ws, confirma el pago con Webpay.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token_ws:
 *                 type: string
 *                 description: Token de Webpay Plus (opcional)
 *               isNewStudent:
 *                 type: boolean
 *               nombreAlumno:
 *                 type: string
 *               apellidosAlumno:
 *                 type: string
 *               rutAlumno:
 *                 type: string
 *               curso:
 *                 type: number
 *               nombreApoderado:
 *                 type: string
 *               rutApoderado:
 *                 type: string
 *     responses:
 *       200:
 *         description: Matrícula exitosa
 *       400:
 *         description: Pago no autorizado
 *       500:
 *         description: Error interno
 */
app.post('/api/matriculas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Llamar al servicio que contiene la lógica de negocio y validación de cupos
    const result = await procesarMatricula(client, req.body, webpay);

    await client.query('COMMIT');
    return res.json(result);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar POST /api/matriculas:', error);
    return res.status(400).json({ error: error.message || 'Error al procesar la matrícula' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`Servicio MsMatriculas ejecutándose en el puerto ${PORT}`);
});

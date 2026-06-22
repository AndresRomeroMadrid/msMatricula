/**
 * Servicio para procesar la lógica de negocio de la matrícula
 */

async function procesarMatricula(client, reqBody, webpay) {
  // 1. Si se envía token_ws, validar la transacción con Webpay antes de guardar
  if (reqBody.token_ws && webpay) {
    const commitResponse = await webpay.commit(reqBody.token_ws);
    if (commitResponse.status !== 'AUTHORIZED') {
      throw new Error('Pago no autorizado por Webpay.');
    }
  }

  const {
    isNewStudent,
    nombreAlumno,
    apellidosAlumno,
    rutAlumno,
    curso: cursoId,
    nombreApoderado,
    rutApoderado,
    edadAlumno
  } = reqBody;

  // 1.5. REGLA DE NEGOCIO: Validar que el formulario esté completo
  if (!nombreAlumno || !apellidosAlumno || !rutAlumno || !cursoId || !nombreApoderado || !rutApoderado || edadAlumno === undefined) {
    throw new Error('Todos los campos del formulario son obligatorios.');
  }

  // 1.6. REGLA DE NEGOCIO: Validar edad del alumno
  if (edadAlumno < 4 || edadAlumno > 18) {
    throw new Error('La edad del alumno debe estar entre 4 y 18 años.');
  }

  // 2. REGLA DE NEGOCIO: Validar capacidad del curso (máximo 30)
  const cuposQuery = 'SELECT COUNT(*) as cant FROM estudiantes WHERE curso_id = $1';
  const cuposRes = await client.query(cuposQuery, [Number(cursoId)]);
  const cantAlumnos = parseInt(cuposRes.rows[0].cant, 10);
  
  if (cantAlumnos >= 30) {
    throw new Error('No hay cupos disponibles en este curso.');
  }

  const cleanRutAlumno = rutAlumno.trim();
  const cleanRutApoderado = rutApoderado.trim();

  // 3. PROCESAR ALUMNO
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

  // 4. PROCESAR APODERADO
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

  return { success: true, estudianteId, apoderadoId };
}

module.exports = {
  procesarMatricula
};

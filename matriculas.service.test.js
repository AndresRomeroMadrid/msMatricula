import { describe, it, expect, vi } from 'vitest';
const { procesarMatricula } = require('./matriculas.service');

describe('Matriculas Service - Lógica de Negocio', () => {
  it('no debería permitir matricularse si faltan datos obligatorios', async () => {
    // Arrange: Preparamos un payload incompleto (falta rutAlumno y curso)
    const reqBodyIncompleto = {
      isNewStudent: true,
      nombreAlumno: 'Juan',
      apellidosAlumno: 'Perez',
      // rutAlumno: falta,
      // curso: falta,
      nombreApoderado: 'Pedro Perez',
      rutApoderado: '98765432-1'
    };

    const mockClient = {
      query: vi.fn()
    };

    // Act & Assert
    await expect(procesarMatricula(mockClient, reqBodyIncompleto, null))
      .rejects
      .toThrow('Todos los campos del formulario son obligatorios.');

    // Verificamos que la BD nunca fue tocada
    expect(mockClient.query).not.toHaveBeenCalled();
  });
  it('no debería permitir matricularse en un curso si no hay cupo (max 30)', async () => {
    // Arrange: Preparamos los datos de entrada
    const reqBody = {
      isNewStudent: true,
      nombreAlumno: 'Juan',
      apellidosAlumno: 'Perez',
      rutAlumno: '12345678-9',
      curso: 1,
      nombreApoderado: 'Pedro Perez',
      rutApoderado: '98765432-1',
      edadAlumno: 10
    };

    // Mock del cliente DB para simular que el curso YA TIENE 30 alumnos
    const mockClient = {
      query: vi.fn().mockImplementation(async (query, params) => {
        if (query.includes('SELECT COUNT(*) as cant FROM estudiantes WHERE curso_id = $1')) {
          return { rows: [{ cant: '30' }] };
        }
        return { rows: [] };
      })
    };

    // Act & Assert: Verificamos que arroje el error correcto
    await expect(procesarMatricula(mockClient, reqBody, null))
      .rejects
      .toThrow('No hay cupos disponibles en este curso.');
      
    // Verificamos que la validación fue la primera y única consulta (abortando tempranamente)
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it('debería permitir matricularse en un curso si hay cupos disponibles', async () => {
    // Arrange
    const reqBody = {
      isNewStudent: true,
      nombreAlumno: 'Juan',
      apellidosAlumno: 'Perez',
      rutAlumno: '12345678-9',
      curso: 1,
      nombreApoderado: 'Pedro Perez',
      rutApoderado: '98765432-1',
      edadAlumno: 10
    };

    // Mock del cliente DB simulando que hay 29 alumnos (queda 1 cupo) y simulación de IDs
    const mockClient = {
      query: vi.fn().mockImplementation(async (query, params) => {
        if (query.includes('SELECT COUNT(*) as cant FROM estudiantes WHERE curso_id = $1')) {
          return { rows: [{ cant: '29' }] };
        }
        if (query.includes('INSERT INTO usuarios')) {
          // Devuelve un ID simulado para estudiante y luego para apoderado
          return { rows: [{ usuario_id: 123 }] };
        }
        if (query.includes('SELECT usuario_id FROM usuarios WHERE rut')) {
          return { rows: [] }; // Simula que no existen ni estudiante ni apoderado previamente
        }
        return { rows: [] };
      })
    };

    // Act
    const result = await procesarMatricula(mockClient, reqBody, null);
    
    // Assert: Debe retornar success true
    expect(result.success).toBe(true);
    expect(result.estudianteId).toBe(123);
    expect(result.apoderadoId).toBe(123);
    
    // Se debieron hacer varias consultas (check cupos, check users, inserts, delete, etc)
    expect(mockClient.query.mock.calls.length).toBeGreaterThan(1);
  });

  it('no debería permitir matricular alumnos menores de 4 años o mayores de 18', async () => {
    // Arrange: Preparamos los datos de entrada con edad inválida
    const reqBodyMenor = {
      isNewStudent: true,
      nombreAlumno: 'Juan',
      apellidosAlumno: 'Perez',
      rutAlumno: '12345678-9',
      curso: 1,
      nombreApoderado: 'Pedro Perez',
      rutApoderado: '98765432-1',
      edadAlumno: 3 // menor de 4
    };

    const reqBodyMayor = {
      ...reqBodyMenor,
      edadAlumno: 19 // mayor de 18
    };

    const mockClient = { query: vi.fn() };

    // Act & Assert
    await expect(procesarMatricula(mockClient, reqBodyMenor, null))
      .rejects
      .toThrow('La edad del alumno debe estar entre 4 y 18 años.');

    await expect(procesarMatricula(mockClient, reqBodyMayor, null))
      .rejects
      .toThrow('La edad del alumno debe estar entre 4 y 18 años.');

    // Verificamos que no llega a la BD
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});

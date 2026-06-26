# MsMatriculas

Microservicio encargado de gestionar el proceso de matrícula escolar. Permite consultar estudiantes por RUT, registrar o actualizar matrículas, y procesar el pago mediante **Webpay Plus (Transbank)** antes de confirmar el registro.

---

## Tecnologías

| Tecnología | Versión |
|---|---|
| Node.js | 18 (Alpine) |
| Express | ^4.18.2 |
| PostgreSQL (`pg`) | ^8.11.3 |
| transbank-sdk | ^6.1.1 |
| dotenv | ^16.3.1 |
| cors | ^2.8.5 |

---

## Variables de entorno

El archivo `.env` debe ubicarse en la raíz del proyecto. Las variables disponibles son:

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PORT` | Puerto en que escucha el servicio | `3003` |
| `DB_URL` | Cadena de conexión a PostgreSQL | `postgresql://postgres:...@db:5432/colegio` |
| `WEBPAY_COMMERCE_CODE` | Código de comercio Webpay (solo producción) | *(usa sandbox si no está definida)* |
| `WEBPAY_API_KEY` | Llave secreta Webpay (solo producción) | *(usa sandbox si no está definida)* |

> **Sandbox (integración):** Si `WEBPAY_COMMERCE_CODE` y `WEBPAY_API_KEY` no están definidas, el servicio usa automáticamente las credenciales de prueba de Transbank:
> - **Tbk-Api-Key-Id:** `597020000540`
> - **Tbk-Api-Key-Secret:** `579B5317441BB0C95557E069884D734E675C3104587E32BB15771A97491E12C2`

---

## Instalación local

```bash
npm install
node index.js
```

---

## Docker

### Dockerfile

El servicio incluye un `Dockerfile` basado en `node:18-alpine` que expone el puerto `3003`.

```bash
docker build -t ms-matriculas .
docker run -p 3003:3003 --env-file .env ms-matriculas
```

### Integración con docker-compose

Ejemplo de configuración para `docker-compose.yml`:

```yaml
ms-matriculas:
  build: ./MsMatriculas
  ports:
    - "3003:3003"
  env_file:
    - ./MsMatriculas/.env
  depends_on:
    - db
```

---

## Endpoints

### `POST /api/matriculas/webpay/create`

Inicia una transacción en Webpay Plus. Devuelve la URL y el token para redirigir al usuario al formulario de pago.

**Body (JSON):**
```json
{
  "amount": 50000,
  "returnUrl": "https://mi-sitio.cl/pago/retorno"
}
```

**Respuesta exitosa:**
```json
{
  "url": "https://webpay3gint.transbank.cl/...",
  "token": "e9d555262db0f989e49d587be1b1af3965b1a498c45d33c193..."
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `amount` | number | ✅ | Monto a cobrar en pesos chilenos |
| `returnUrl` | string | ✅ | URL a la que Webpay redirige tras el pago |

---

### `GET /api/matriculas/estudiantes/:rut`

Busca un estudiante por su RUT y retorna sus datos junto con el apoderado asociado. La búsqueda es insensible al formato del RUT (con o sin puntos y guión).

**Ejemplo:**
```
GET /api/matriculas/estudiantes/12345678-9
```

**Respuesta exitosa (200):**
```json
{
  "estudiante_id": 1,
  "curso_id": 3,
  "estudiante_rut": "12345678-9",
  "estudiante_nombre": "Juan",
  "estudiante_apellido_paterno": "Pérez",
  "estudiante_apellido_materno": "González",
  "estudiante_email": "juan.perez@colegio.cl",
  "estudiante_activo": true,
  "apoderado_id": 5,
  "apoderado_rut": "98765432-1",
  "apoderado_nombre": "María",
  "apoderado_apellido_paterno": "González",
  "apoderado_apellido_materno": "Soto"
}
```

**Respuesta 404:** Estudiante no registrado en el sistema.

---

### `POST /api/matriculas`

Registra o actualiza la matrícula de un estudiante. Si se incluye `token_ws`, primero confirma el pago con Webpay antes de guardar en la base de datos. Si el pago no está autorizado, la matrícula **no** se registra.

**Body (JSON):**
```json
{
  "token_ws": "e9d555262db0f989e49d587be1b1af3965b1a498c45d33c193...",
  "isNewStudent": true,
  "nombreAlumno": "Juan",
  "apellidosAlumno": "Pérez González",
  "rutAlumno": "12345678-9",
  "curso": 3,
  "nombreApoderado": "María González Soto",
  "rutApoderado": "98765432-1"
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `token_ws` | string | ❌ | Token retornado por Webpay al completar el pago |
| `isNewStudent` | boolean | ✅ | `true` para crear un nuevo estudiante, `false` para actualizar |
| `nombreAlumno` | string | ✅ | Nombre(s) del alumno |
| `apellidosAlumno` | string | ✅ | Apellidos del alumno (paterno y materno separados por espacio) |
| `rutAlumno` | string | ✅ | RUT del alumno |
| `curso` | number | ✅ | ID del curso a matricular |
| `nombreApoderado` | string | ✅ | Nombre completo del apoderado |
| `rutApoderado` | string | ✅ | RUT del apoderado |

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "estudianteId": 1,
  "apoderadoId": 5
}
```

**Respuesta 400:** Pago no autorizado por Webpay.

---

## Flujo de pago con Webpay

```
1. Frontend llama a POST /api/matriculas/webpay/create  →  obtiene { url, token }
2. Frontend redirige al usuario a `url` con el `token`
3. Usuario completa el pago en el formulario de Transbank
4. Transbank redirige al usuario a `returnUrl` con `token_ws` en el body
5. Frontend llama a POST /api/matriculas enviando `token_ws` + datos de matrícula
6. El microservicio confirma el pago con Transbank y, si es AUTHORIZED, guarda la matrícula
```

---

## Estructura del proyecto

```
MsMatriculas/
├── index.js          # Lógica principal del microservicio
├── package.json      # Dependencias y scripts
├── .env              # Variables de entorno (no subir a repositorio)
├── Dockerfile        # Imagen Docker del servicio
└── README.md         # Documentación
```
## Pruebas Unitarias (Vitest)

Para asegurar la calidad y fiabilidad del proceso de matrícula, se implementaron pruebas unitarias utilizando **Vitest**.

### ¿Qué se evaluó?
Se evaluó la lógica central del servicio de matrículas (ubicada en `matriculas.service.test.js` o equivalente), cubriendo las siguientes reglas de negocio:

1. **Datos obligatorios:** Se valida que el sistema rechace el intento de matrícula si faltan campos clave (por ejemplo, nombre, RUT, curso).
2. **Control de cupos:** Se asegura que el curso no exceda su límite máximo permitido (30 estudiantes).
3. **Matrícula exitosa:** Se verifica que el flujo de inscripción funcione correctamente cuando se cumplen todas las condiciones, se tiene el cupo y los datos son válidos.
4. **Rango de edad:** Se comprueba que la edad del estudiante esté estrictamente dentro del rango permitido (entre 4 y 18 años).

### ¿Cómo ejecutarlas?
Asegúrate de haber instalado las dependencias (`npm install`) y luego ejecuta el siguiente comando en la raíz del microservicio:

```bash
npx vitest run
```

### Resultados esperados
Al ejecutar el comando, Vitest correrá la suite de pruebas sin necesidad de levantar una base de datos real (mediante mocking o en un entorno aislado) y deberías ver en la consola que los **4 tests pasan exitosamente**, indicando que la lógica de validación funciona tal como se espera.

```text
 RUN  v4.1.9

 ✓ matriculas.service.test.js (4 tests)

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

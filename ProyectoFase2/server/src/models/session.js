const db = require('../config/db')

const SELECT_BASE = `
    SELECT 
        s.id_sesion,
        s.id_tutor AS id_tutor,
        s.fecha_sesion AS fecha,
        s.hora_sesion AS hora,
        s.motivo,
        s.estado,
        e.id_estudiante,
        CONCAT(e.nombre, ' ', e.apellido) AS nombre_estudiante,
        e.correo AS correo_estudiante,
        CONCAT(t.nombre, ' ', t.apellido) AS nombre_tutor,
        m.nombre AS materia
    FROM sesion s
    JOIN estudiante e ON s.id_estudiante = e.id_estudiante
    JOIN tutor t ON s.id_tutor = t.id_tutor
    JOIN materia m ON s.id_materia = m.id_materia
`;

function mapSessionRow(row) {
    return {
        id: row.id_sesion,
        fecha: row.fecha.toISOString().slice(0, 10), // Formatear a "YYYY-MM-DD"
        hora: row.hora.slice(0, 5), // Formatear a "HH:MM"
        estudiante: row.nombre_estudiante,
        correoEstudiante: row.correo_estudiante,
        id_tutor: row.id_tutor,
        tutor: row.nombre_tutor,
        materia: row.materia,
        motivo: row.motivo,
        estado: row.estado // 'Activa','Atendida','Cancelada_Estudiante','Cancelada_Tutor'
    }
}

// Obtiene todas las sesiones pendientes de un tutor por su ID
const getSesionesPendientesByTutorId = async (id_Tutor) => {
    const result = await db.query(
        `${SELECT_BASE}
        WHERE s.id_tutor = $1 AND s.estado = 'Activa'
        ORDER BY s.fecha_sesion ASC, s.hora_sesion ASC;
        `, 
        [id_Tutor]
    );
    return result.rows.map(mapSessionRow);
}

// Busca una sesión por su ID y el tutor
const findSessionByIdAndTutorId = async (sessionId, id_Tutor) => {
    const result = await db.query(`${SELECT_BASE} WHERE s.id_sesion = $1 AND s.id_tutor = $2`, [sessionId, id_Tutor]);
    if (result.rowCount === 0) return null;
    return mapSessionRow(result.rows[0]);

}

// activa esquivale a sesion pendiente
const ESTADOS_SESION = {
    Atendida: 'Atendido',
    Cancelada_Estudiante: 'Cancelado por estudiante',
    Cancelada_Tutor: 'Cancelado por tutor',
};

// Obtiene el historial de sesiones de un tutor por su ID
// Es offset sera de ayuda para ordenar las sesiones de manera descendente y paginarlas si es necesario
const findHistoryByTutor = async (id_Tutor, { page = 1, limit = 20 } = {}) => {
    const offset = (page - 1) * limit;

    const totalResult = await db.query(
        `SELECT COUNT(*)::int AS total FROM sesion s WHERE s.id_tutor = $1 AND s.estado <> 'Activa'`,
        [id_Tutor]
    );

    const result = await db.query(
        `${SELECT_BASE}
        WHERE s.id_tutor = $1 AND s.estado <> 'Activa'
        ORDER BY s.fecha_sesion DESC, s.hora_sesion DESC
        LIMIT $2 OFFSET $3;`,
        [id_Tutor, limit, offset]
    );
    //return result.rows.map(mapSessionRow);
    const data = result.rows.map((row) => ({
        id: row.id_sesion,
        fecha: row.fecha.toISOString().slice(0, 10), // Formatear a "YYYY-MM-DD"
        hora: row.hora.slice(0, 5), // Formatear a "HH:MM"
        estudiante: row.nombre_estudiante,
        estado: row.estado, // 'Activa','Atendida','Cancelada_Estudiante','Cancelada_Tutor'
        estadoDescripcion: ESTADOS_SESION[row.estado] || row.estado, 
    }));

    return { data, total: result.rows.length }; // devuelve las sess
}

// Marca la sesión como atendida guardando el plan de estudio
const markAttended = async (sessionId, id_Tutor, {difficulties, resources}) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(
            `UPDATE sesion
            SET estado = 'Atendida', fecha_actualizacion = NOW()
            WHERE id_sesion = $2 AND id_tutor = $3
            RETURNING id_sesion, estado, fecha_actualizacion`,
            [sessionId, id_Tutor]
        );

        if (sessionResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return null
        }; 

        // insertar un nuevo plan de estudio para la sesión atendida
        const planResult = await client.query(
            `INSERT INTO study_plans (id_sesion)
            VALUES ($1)
            RETURNING id_plan`,
            [sessionId]
        );
        const id_plan = planResult.rows[0].id_plan;

        // Insertar las dificultades identificadas
        const dificultyResult = await client.query(
            `INSERT INTO identified_difficulties (id_plan, descripcion)
            VALUES ($1, $2)
            RETURNING descripcion`,
            [id_plan, difficulties]
        );

        // Insertar los recursos recomendados
        const insertResources = [];
        for (const resource of resources) {
            const resourceResult = await client.query(
                `INSERT INTO recommended_resources (id_plan, nombre, tipo, descripcion_uso)
                VALUES ($1, $2, $3, $4)
                RETURNING id_recurso, nombre, tipo, descripcion_uso`,
                [id_plan, resource.nombre.trim(), resource.tipo, resource.descripcion.trim()]
            );
            const r = resourceResult.rows[0];
            insertResources.push({
                id: r.id_recurso,
                name: r.nombre,
                type: r.tipo,
                description: r.descripcion_uso
            });
        }

        await client.query('COMMIT');

        const row = sessionResult.rows[0];
        return {
            id: row.id_sesion,
            estado: row.estado,
            fechaActualizacion: row.fecha_actualizacion,
            dificultades: dificultyResult.rows[0].descripcion,
            recursos: insertResources,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Busca una sesión por su ID y el tutor, para obtener detalles de la sesión, reutilizamos la función findSessionByIdAndTutorId para obtener los detalles de la sesión
const findSessionDetailByIdAndTutorId = async (sessionId, id_Tutor) => {
    const sesion = await findSessionByIdAndTutorId(sessionId, id_Tutor);
    if (!sesion) return null;

    const planResult = await db.query(
        `SELECT id_plan FROM study_plans WHERE id_sesion = $1`,
        [sessionId]
    );
    if (planResult.rowCount === 0) {
        return { ...sesion, plan: null };
    }
    const id_plan = planResult.rows[0].id_plan;

    const difficultiesResult = await db.query(
        `SELECT descripcion FROM identified_difficulties WHERE id_plan = $1`,
        [id_plan]
    );

    const resourcesResult = await db.query(
        `SELECT id_recurso, nombre, tipo, descripcion_uso 
        FROM recommended_resources 
        WHERE id_plan = $1
        ORDER BY id_recurso ASC`,
        [id_plan]
    );

    return {
        ...sesion,
        plan: {
            dificulties: difficultiesResult.rows[0]?.descripcion || null,
            resources: resourcesResult.rows.map((r) => ({
                id: r.id_recurso,
                name: r.nombre,
                type: r.tipo,
                description: r.descripcion_uso
            })),
        },
    };
}

// Marca la sesión como cancelada por el tutor 
const markCancelledByTutor = async (sessionId, id_Tutor) => {
    const result = await db.query(
        `UPDATE sesion
        SET estado = 'Cancelada_Tutor', fecha_actualizacion = now()
        WHERE id_sesion = $1 AND id_tutor = $2
        RETURNING id_sesion, estado, fecha_actualizacion`,
        [sessionId, id_Tutor]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
        id: row.id_sesion,
        estado: row.estado,
        fechaCancelacion: row.fecha_actualizacion,
    };
}

module.exports = {
    getSesionesPendientesByTutorId,
    findHistoryByTutor,
    findSessionByIdAndTutorId,
    findSessionDetailByIdAndTutorId,
    markAttended,
    markCancelledByTutor
}
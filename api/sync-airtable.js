import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { id_supabase, fecha, hora, estado, servicio, especialista } = req.body;

    if (!id_supabase) {
      return res.status(400).json({ error: 'Falta ID de Supabase' });
    }

    console.log(`🔄 Sincronizando cita ${id_supabase} desde Airtable...`);

    // 1. Resolver IDs de servicio y especialista si han cambiado
    let updateData = {};

    if (servicio) {
      const { data: s } = await supabase.from('servicios').select('id').ilike('nombre', `%${servicio}%`).maybeSingle();
      if (s) {
        updateData.servicio_id = s.id;
        updateData.servicio_aux = servicio;
      }
    }

    if (especialista) {
      const { data: e } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialista}%`).maybeSingle();
      if (e) {
        updateData.especialista_id = e.id;
      }
    }

    // 2. Preparar datos de actualización (Fecha, Hora, Estado)
    if (fecha && hora) {
      updateData.fecha_hora = `${fecha}T${hora}:00-05:00`;
    }
    if (estado) {
      updateData.estado = estado;
    }

    const { error } = await supabase
      .from('citas')
      .update(updateData)
      .eq('id', id_supabase);

    if (error) throw error;

    return res.status(200).json({ success: true, message: `Cita ${id_supabase} sincronizada correctamente.` });

  } catch (error) {
    console.error('❌ Error en sincronización:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

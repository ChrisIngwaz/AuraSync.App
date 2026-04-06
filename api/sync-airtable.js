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
    let servicio_id = null;
    let especialista_id = null;

    if (servicio) {
      const { data: s } = await supabase.from('servicios').select('id').ilike('nombre', `%${servicio}%`).maybeSingle();
      if (s) servicio_id = s.id;
    }

    if (especialista) {
      const { data: e } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialista}%`).maybeSingle();
      if (e) especialista_id = e.id;
    }

    // 2. Actualizar en Supabase
    const updateData = {};
    if (fecha && hora) updateData.fecha_hora = `${fecha}T${hora}:00`;
    if (estado) updateData.estado = estado;
    if (servicio_id) updateData.servicio_id = servicio_id;
    if (especialista_id) updateData.especialista_id = especialista_id;
    if (servicio) updateData.servicio_aux = servicio;

    const { error } = await supabase
      .from('citas')
      .update(updateData)
      .eq('id', id_supabase);

    if (error) throw error;

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error en sincronización:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

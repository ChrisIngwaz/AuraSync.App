import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();

  try {
    // 1. PROCESAMIENTO DE ENTRADA
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, 
        { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` }, timeout: 15000 });
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. DATOS DE CLIENTE Y NEGOCIO
    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    // 3. VISIÓN DE AGENDA (Para que Aura no proponga huecos llenos)
    const ahora = new Date();
    const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString();
    const finHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 23, 59, 59).toISOString();
    const { data: citasHoy } = await supabase.from('citas').select('fecha_hora, especialista_id, servicios(duracion, nombre)')
      .eq('estado', 'confirmada').gte('fecha_hora', inicioHoy).lte('fecha_hora', finHoy);

    const agendaResumen = citasHoy?.map(c => {
      const h = new Date(c.fecha_hora).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false });
      const esp = especialistas.find(e => e.id === c.especialista_id)?.nombre || "Especialista";
      return `- ${esp} ocupado a las ${h} (${c.servicios?.nombre})`;
    }).join('\n') || "Agenda libre.";

    // 4. SYSTEM PROMPT
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Guayaquil' }).format(ahora);
    const systemPrompt = `Nombre: Aura. Cargo: Guardiana de la Coherencia de AuraSync.
Reglas: Warm, executive, human.
Agenda hoy (${hoyEcuador}):
${agendaResumen}
Especialistas: ${especialistas?.map(e => e.nombre).join(', ')}.
DATA_JSON:{"nombre":"${cliente?.nombre || ''}","apellido":"${cliente?.apellido || ''}","cita_fecha":"YYYY-MM-DD","cita_hora":"HH:MM","cita_servicio":"...","cita_especialista":"..."}`;

    // 5. AI COMPLETION
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoUsuario }], temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let citaCreada = false;
    let mensajeError = "";

    // 6. EXTRACCIÓN Y VALIDACIÓN DE DATOS (REPARADO)
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    if (jsonMatch) {
      const datos = JSON.parse(jsonMatch[1].trim());
      
      // Asegurar que el servicio existe en nuestra DB para obtener PRECIO y DURACIÓN
      const servicioDb = servicios?.find(s => s.nombre.toLowerCase().trim() === datos.cita_servicio.toLowerCase().trim());
      const especialistaDb = especialistas?.find(e => e.nombre.toLowerCase().trim() === datos.cita_especialista.toLowerCase().trim());

      const tieneFechaValida = datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/);
      const tieneHoraValida = datos.cita_hora?.match(/^\d{2}:\d{2}$/);

      if (tieneFechaValida && tieneHoraValida && servicioDb) {
        const duracionReal = servicioDb.duracion; // Uso de int4
        const precioReal = servicioDb.precio;
        const inicioCita = new Date(`${datos.cita_fecha}T${datos.cita_hora}:00-05:00`);
        const finCita = new Date(inicioCita.getTime() + duracionReal * 60000);

        // Verificar Disponibilidad Matemática
        const disponibilidad = await verificarDisponibilidad(supabase, datos.cita_fecha, inicioCita, finCita, especialistaDb?.id);

        if (disponibilidad.disponible) {
          // AHORA SÍ: Enviamos el precioReal y duracionReal recuperados de Supabase
          const okAirtable = await crearCitaAirtable({
            telefono: userPhone, nombre: cliente?.nombre || datos.nombre, apellido: cliente?.apellido || datos.apellido,
            fecha: datos.cita_fecha, hora: datos.cita_hora, servicio: servicioDb.nombre,
            especialista: especialistaDb?.nombre || "Por asignar", precio: precioReal
          });

          if (okAirtable) {
            await supabase.from('citas').insert({
              cliente_id: cliente?.id, servicio_id: servicioDb.id, especialista_id: especialistaDb?.id,
              fecha_hora: inicioCita.toISOString(), estado: 'confirmada'
            });
            citaCreada = true;
          }
        } else {
          mensajeError = disponibilidad.mensaje;
        }
      }
    }

    // 7. RESPUESTA AL USUARIO
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) cleanReply += `\n\n✅ Cita confirmada.`;
    else if (mensajeError) cleanReply += `\n\n⚠️ ${mensajeError}`;

    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    return res.status(200).send('<Response><Message>Error técnico, por favor intenta de nuevo.</Message></Response>');
  }
}

async function verificarDisponibilidad(supabase, fecha, nInicio, nFin, espId) {
  const iDia = new Date(`${fecha}T00:00:00-05:00`).toISOString();
  const fDia = new Date(`${fecha}T23:59:59-05:00`).toISOString();
  const { data: citas } = await supabase.from('citas').select('fecha_hora, servicios(duracion), especialista_id').eq('estado', 'confirmada').gte('fecha_hora', iDia).lte('fecha_hora', fDia);

  const chequear = (id) => {
    return (citas?.filter(c => c.especialista_id === id) || []).some(c => {
      const exI = new Date(c.fecha_hora);
      const exF = new Date(exI.getTime() + (c.servicios?.duracion || 30) * 60000);
      return (nInicio < exF && nFin > exI);
    });
  };

  if (espId) {
    if (chequear(espId)) return { disponible: false, mensaje: "Horario ocupado para ese especialista." };
  } else {
    const { data: todos } = await supabase.from('especialistas').select('id');
    if (!todos.some(e => !chequear(e.id))) return { disponible: false, mensaje: "No hay disponibilidad en ese horario." };
  }
  return { disponible: true };
}

async function crearCitaAirtable(d) {
  try {
    await axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
      records: [{ fields: { "Cliente": `${d.nombre} ${d.apellido || ''}`.trim(), "Servicio": d.servicio, "Fecha": d.fecha, "Hora": d.hora, "Especialista": d.especialista, "Teléfono": d.telefono, "Estado": "Confirmada", "Importe estimado": d.precio } }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }});
    return true;
  } catch (e) { return false; }
}

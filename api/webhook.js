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

    // 2. DATOS DE CLIENTE, NEGOCIO E HISTORIAL
    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');
    
    // Recuperar historial para mantener la memoria
    const { data: historial } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
    const historialReverse = historial?.reverse() || [];

    // 3. CÁLCULO DE DISPONIBILIDAD REAL (HUECOS LIBRES)
    const ahora = new Date();
    const hoyStr = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    const inicioHoy = new Date(`${hoyStr}T00:00:00-05:00`).toISOString();
    const finHoy = new Date(`${hoyStr}T23:59:59-05:00`).toISOString();

    const { data: citasHoy } = await supabase.from('citas').select('fecha_hora, especialista_id, servicios(duracion)')
      .eq('estado', 'confirmada').gte('fecha_hora', inicioHoy).lte('fecha_hora', finHoy);

    // Definimos bloques de 1 hora para la consulta de disponibilidad
    const bloques = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    const disponibilidadResumen = especialistas?.map(esp => {
      const ocupados = citasHoy?.filter(c => c.especialista_id === esp.id).map(c => 
        new Date(c.fecha_hora).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })
      ) || [];
      const libres = bloques.filter(b => !ocupados.includes(b));
      return `${esp.nombre}: Libres a las [${libres.join(', ')}]`;
    }).join('\n') || "Todos los especialistas están libres hoy.";

    // 4. NUEVO SYSTEM PROMPT: COORDINADORA DE ÉLITE
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Guayaquil' }).format(ahora);
    
    const systemPrompt = `Eres Aura, la Coordinadora de Élite de AuraSync. Tu gestión es impecable, humana y sumamente eficiente.

[REGLAS DE ORO]
1. MEMORIA TOTAL: Si el usuario ya mencionó el servicio, la hora o el especialista en el historial, NO lo vuelvas a preguntar. Confírmalo directamente.
2. CERO ESPERAS: Nunca digas "déjame revisar" o "un momento". Tú ya tienes la agenda frente a ti.
3. VERACIDAD: Usa la "DISPONIBILIDAD REAL" abajo. Si la hora está en la lista de Libres, dile que SÍ hay espacio de inmediato.
4. PROACTIVIDAD: Si el cliente pide una hora ocupada, ofrece inmediatamente las 2 opciones libres más cercanas.
5. NO INVENTAR: No menciones servicios que no estén en la lista.

[DISPONIBILIDAD REAL HOY - ${hoyEcuador}]
${disponibilidadResumen}

[SERVICIOS]
${servicios?.map(s => `${s.nombre} ($${s.price || s.precio})`).join(', ')}

[DATA_JSON]
Mantén los valores que ya conozcas. Si faltan, usa "...".
DATA_JSON:{"nombre":"${cliente?.nombre || ''}","cita_fecha":"${hoyStr}","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

    // 5. AI COMPLETION
    const messages = [{ role: "system", content: systemPrompt }];
    historialReverse.forEach(h => messages.push({ role: h.rol === 'assistant' ? 'assistant' : 'user', content: h.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", messages: messages, temperature: 0.2
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let citaCreada = false;
    let mensajeError = "";

    // 6. EXTRACCIÓN Y AGENDAMIENTO
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    if (jsonMatch) {
      const datos = JSON.parse(jsonMatch[1].trim());
      
      const servicioDb = servicios?.find(s => s.nombre.toLowerCase().trim() === datos.cita_servicio.toLowerCase().trim());
      const especialistaDb = especialistas?.find(e => e.nombre.toLowerCase().trim() === datos.cita_especialista.toLowerCase().trim());

      if (datos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/) && datos.cita_hora.match(/^\d{2}:\d{2}$/) && servicioDb) {
        const inicioCita = new Date(`${datos.cita_fecha}T${datos.cita_hora}:00-05:00`);
        const finCita = new Date(inicioCita.getTime() + (servicioDb.duracion || 30) * 60000);

        const disponibilidad = await verificarDisponibilidad(supabase, datos.cita_fecha, inicioCita, finCita, especialistaDb?.id);

        if (disponibilidad.disponible) {
          const okAirtable = await crearCitaAirtable({
            telefono: userPhone, nombre: cliente?.nombre || datos.nombre || "Cliente",
            fecha: datos.cita_fecha, hora: datos.cita_hora, servicio: servicioDb.nombre,
            especialista: especialistaDb?.nombre || "Cualquiera", precio: servicioDb.precio
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

    // 7. RESPUESTA Y GUARDADO
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) cleanReply += `\n\n✅ ¡Hecho! Tu cita está agendada.`;
    else if (mensajeError) cleanReply += `\n\n⚠️ ${mensajeError}`;

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error(err);
    return res.status(200).send('<Response><Message>Disculpa, tuve un pequeño inconveniente técnico. ¿Podemos intentarlo de nuevo?</Message></Response>');
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
    if (chequear(espId)) return { disponible: false, mensaje: "Ese horario ya está reservado con ese especialista." };
  } else {
    const { data: todos } = await supabase.from('especialistas').select('id');
    if (!todos.some(e => !chequear(e.id))) return { disponible: false, mensaje: "Lo siento, ya no tenemos especialistas libres a esa hora." };
  }
  return { disponible: true };
}

async function crearCitaAirtable(d) {
  try {
    await axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
      records: [{ fields: { "Cliente": d.nombre, "Servicio": d.servicio, "Fecha": d.fecha, "Hora": d.hora, "Especialista": d.especialista, "Teléfono": d.telefono, "Estado": "Confirmada", "Importe estimado": d.precio } }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }});
    return true;
  } catch (e) { return false; }
}

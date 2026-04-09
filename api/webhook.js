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

const TIMEZONE = 'America/Guayaquil';

// --- FUNCIONES DE APOYO ---

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const fecha = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return fechaISO || 'fecha por confirmar';
  }
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

// NUEVA FUNCIÓN: Para que Aura sepa qué citas tiene el cliente realmente
async function buscarCitasActivasAirtable(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const res = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    return res.data.records.map(r => ({
      servicio: r.fields.Servicio,
      hora: r.fields.Hora,
      especialista: r.fields.Especialista,
      id: r.id
    }));
  } catch (e) {
    return [];
  }
}

// --- HANDLER PRINCIPAL ---

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = (From || '').replace('whatsapp:', '').trim();

  try {
    let textoUsuario = Body || "";
    
    // Transcripción de Audio
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        return res.status(200).send('<Response><Message>Disculpa, tuve un problema con el audio. ¿Me lo podrías escribir? 🌸</Message></Response>');
      }
    }

    // Datos del Cliente y Citas Reales
    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const citasReales = await buscarCitasActivasAirtable(userPhone);
    const infoCitas = citasReales.length > 0 
      ? citasReales.map(c => `- ${c.servicio} con ${c.especialista} a las ${c.hora}`).join('\n')
      : "El cliente no tiene citas agendadas actualmente.";

    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    const listaEsp = especialistas?.map(e => `${e.nombre} (${e.expertise})`).join(', ');
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ');

    // CONFIGURACIÓN DE PERSONALIDAD DE AURA
    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Eres una concierge de lujo, sofisticada y humana.

[CITAS REALES DEL CLIENTE EN ESTE MOMENTO]
${infoCitas}

[IDENTIDAD]
- Tono: Elegante, profesional y cálido.
- IMPORTANTE: Si el cliente pregunta por su cita, NO inventes datos. Usa la lista de [CITAS REALES DEL CLIENTE EN ESTE MOMENTO].
- FLUJO HUMANO: Para parecer una persona real, divide tus respuestas en dos partes cuando verifiques algo usando el separador "###".
  Ejemplo: "¡Hola, Chris! Claro, déjame verificar eso para ti. ### Tienes un corte de cabello agendado para hoy a las 17:00."

[REGLAS DE ORO]
- Si recomiendas a un especialista, espera a que el cliente acepte antes de agendar (accion: "none").
- NUNCA escribas tú misma el checkmark (✅). El sistema lo pondrá solo si la reserva es exitosa.
- No seas un bot eficiente; sé una asistente con clase.

[FECHAS IMPORTANTE]
- Hoy es: ${formatearFecha(getFechaEcuador())}
- Mañana es: ${formatearFecha(getFechaEcuador(1))}

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente:
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "..."
}`;

    const messages = [{ role: "system", content: systemPrompt }];
    
    // Historial de conversación
    const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
    if (mensajes) mensajes.reverse().forEach(msg => messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido }));
    
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        const accion = datosExtraidos.accion || 'none';
        
        // Lógica de Fechas
        const ahoraUTC = new Date();
        const minutosEcuador = (ahoraUTC.getUTCHours() * 60) + ahoraUTC.getUTCMinutes() - (5 * 60);
        const esAyerEnEcuador = minutosEcuador < 0;
        const fechaBase = new Date(Date.UTC(ahoraUTC.getUTCFullYear(), ahoraUTC.getUTCMonth(), ahoraUTC.getUTCDate()));
        if (esAyerEnEcuador) fechaBase.setUTCDate(fechaBase.getUTCDate() - 1);
        const fechaHoyStr = `${fechaBase.getUTCFullYear()}-${String(fechaBase.getUTCMonth() + 1).padStart(2, '0')}-${String(fechaBase.getUTCDate()).padStart(2, '0')}`;
        
        let fechaFinal = datosExtraidos.cita_fecha || fechaHoyStr;

        if (accion === 'cancelar') {
          const resCancel = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
          mensajeAccion = resCancel ? "✅ Cita cancelada exitosamente." : "No encontré citas para cancelar.";
          accionEjecutada = true;
        }
        else if (accion === 'reagendar') {
          const resReag = await reagendarCitaAirtable(userPhone, { ...datosExtraidos, cita_fecha: fechaFinal });
          mensajeAccion = resReag ? `✅ Cita reprogramada para el ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora}.` : "No pude reprogramar.";
          accionEjecutada = true;
        }
        else if (accion === 'agendar') {
          let servicioData = servicios?.find(s => s.nombre.toLowerCase().includes((datosExtraidos.cita_servicio || '').toLowerCase())) || { nombre: datosExtraidos.cita_servicio, precio: 0, duracion: 60 };
          const disponible = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);

          if (!disponible.ok) {
            const alternativa = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);
            mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
          } else {
            const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
            const resAgendar = await crearCitaAirtable({
              telefono: userPhone, nombre: cliente?.nombre || datosExtraidos.nombre, fecha: fechaFinal, hora: datosExtraidos.cita_hora, servicio: servicioData.nombre, especialista: especialistaFinal, precio: servicioData.precio, duracion: servicioData.duracion
            });
            if (resAgendar) mensajeAccion = `✅ Cita confirmada: ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora} con ${especialistaFinal}.`;
          }
          accionEjecutada = true;
        }
      } catch (e) { console.error('Error JSON:', e.message); }
    }

    if (accionEjecutada && mensajeAccion) cleanReply = `${cleanReply}\n\n${mensajeAccion}`;

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    // DIVISIÓN DE MENSAJES PARA WHATSAPP
    const partesMensaje = cleanReply.split('###').map(p => p.trim()).filter(p => p !== "");
    const xmlMessages = partesMensaje.map(msg => `<Message>${msg}</Message>`).join('');

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response>${xmlMessages}</Response>`);

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento de distracción. 🌸</Message></Response>');
  }
}

// --- FUNCIONES DE AIRTABLE ---

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    const payload = { records: [{ fields: { "Cliente": datos.nombre, "Servicio": datos.servicio, "Fecha": fechaUTC, "Hora": datos.hora, "Especialista": datos.especialista, "Teléfono": datos.telefono, "Estado": "Confirmada", "Importe estimado": datos.precio, "Duración estimada (minutos)": datos.duracion } }] };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (error) { return false; }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    if (busqueda.data.records.length === 0) return false;
    const recordId = citaId || busqueda.data.records[0].id;
    await axios.patch(`${url}`, { records: [{ id: recordId, fields: { "Estado": "Cancelada" } }] }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (error) { return false; }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    if (busqueda.data.records.length === 0) return false;
    const recordId = datos.cita_id || busqueda.data.records[0].id;
    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    await axios.patch(`${url}`, { records: [{ id: recordId, fields: { "Fecha": fechaUTC, "Hora": datos.cita_hora, "Estado": "Confirmada" } }] }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (error) { return false; }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialistaSolicitado, duracionMinutos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    const citas = response.data.records;
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracionMinutos || 60);
    for (const cita of citas) {
      const [he, me] = cita.fields.Hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + (cita.fields['Duración estimada (minutos)'] || 60);
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialistaSolicitado || cita.fields.Especialista === especialistaSolicitado) return { ok: false };
      }
    }
    return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
  } catch (error) { return { ok: true }; }
}

async function buscarAlternativaAirtable(fecha, horaSolicitada, especialistaSolicitado, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    const ocupados = response.data.records.map(c => ({ hora: c.fields.Hora, duracion: c.fields['Duración estimada (minutos)'] || 60, especialista: c.fields.Especialista }));
    const [h, m] = horaSolicitada.split(':').map(Number);
    let horaPropuesta = h * 60 + m;
    while (horaPropuesta <= 1080 - duracion) {
      let conflicto = false;
      for (const ocup of ocupados) {
        const [ho, mo] = ocup.hora.split(':').map(Number);
        if (horaPropuesta < (ho * 60 + mo + ocup.duracion) && (horaPropuesta + duracion) > (ho * 60 + mo)) {
          if (!especialistaSolicitado || ocup.especialista === especialistaSolicitado) { conflicto = true; break; }
        }
      }
      if (!conflicto) {
        const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
        return { mensaje: `¿Te funciona a las ${horaStr}?`, hora: horaStr };
      }
      horaPropuesta += 15;
    }
    return { mensaje: "Ese día está completo." };
  } catch (error) { return { mensaje: "¿Te funciona otro horario?" }; }
}

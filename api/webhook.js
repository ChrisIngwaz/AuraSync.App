import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import twilio from 'twilio';
import syncAirtable from './sync-airtable.js';
import dailyReport from './daily-report.js';
import reminders from './reminders.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER
};

const { MessagingResponse } = twilio.twiml;

// ============ RUTAS DE LA API ============

app.post('/api/sync-airtable', syncAirtable);
app.get('/api/daily-report', dailyReport);
app.get('/api/reminders', reminders);

// ============ UTILIDADES DE TIEMPO ============

function timeToMinutes(hora) {
  if (!hora || typeof hora !== 'string') return 0;
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

// ============ FUNCIONES DE APOYO ============

async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    if (!especialistaId || especialistaId === '...' || especialistaId === 'Asignar') return { disponible: true };
    
    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    
    // Horario de atención: 9:00 a 18:00
    if (inicioNueva < 540 || finNueva > 1080) {
      return { disponible: false, mensaje: "Esa hora está fuera de nuestro horario de atención (9:00 - 18:00)." };
    }

    const { data: citasExistentes } = await supabase
      .from('citas')
      .select('fecha_hora, duracion_aux, servicio_aux')
      .eq('especialista_id', especialistaId)
      .gte('fecha_hora', `${fecha}T00:00:00`)
      .lte('fecha_hora', `${fecha}T23:59:59`)
      .in('estado', ['Confirmada', 'En proceso']);

    for (const cita of citasExistentes || []) {
      const horaExistente = cita.fecha_hora.includes('T') ? cita.fecha_hora.split('T')[1].substring(0, 5) : cita.fecha_hora.substring(11, 16);
      const inicioExistente = timeToMinutes(horaExistente);
      const finExistente = inicioExistente + (cita.duracion_aux || 60);
      
      if (inicioNueva < finExistente && finNueva > inicioExistente) {
        return { disponible: false, mensaje: `El especialista ya tiene una cita de "${cita.servicio_aux}" a las ${horaExistente}.` };
      }
    }
    return { disponible: true };
  } catch (error) { 
    console.error('Error disponibilidad:', error);
    return { disponible: false, mensaje: "Error al verificar la agenda." }; 
  }
}

async function obtenerIdsRelacionales(servicioNombre, especialistaNombre) {
  let res = { servicioId: null, especialistaId: null, duracion: 60, precio: 0 };
  if (servicioNombre && servicioNombre !== '...') {
    const { data: s } = await supabase.from('servicios').select('id, duracion, precio').ilike('nombre', `%${servicioNombre}%`).maybeSingle();
    if (s) { res.servicioId = s.id; res.duracion = s.duracion; res.precio = s.precio; }
  }
  if (especialistaNombre && especialistaNombre !== '...' && especialistaNombre !== 'Asignar') {
    const { data: e } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialistaNombre}%`).maybeSingle();
    if (e) res.especialistaId = e.id;
  }
  return res;
}

async function registrarCita(datos) {
  const fechaHora = `${datos.fecha}T${datos.hora}:00-05:00`;
  const { data, error } = await supabase.from('citas').insert({
    cliente_id: datos.clienteId,
    servicio_id: datos.servicioId,
    especialista_id: datos.especialistaId,
    fecha_hora: fechaHora,
    estado: 'Confirmada',
    nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(),
    servicio_aux: datos.servicio,
    duracion_aux: datos.duracion
  }).select().single();

  if (error) throw error;

  // Sincronizar con Airtable
  await axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
    records: [{ fields: {
      "ID_Supabase": data.id,
      "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
      "Servicio": datos.servicio,
      "Fecha": datos.fecha,
      "Hora": datos.hora,
      "Especialista": datos.especialista,
      "Teléfono": datos.telefono,
      "Estado": "Confirmada",
      "Importe estimado": datos.precio,
      "Duración estimada (minutos)": datos.duracion
    } }]
  }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });

  return { success: true, id: data.id };
}

async function reagendarCita(citaId, nuevaFecha, nuevaHora) {
  const fechaHora = `${nuevaFecha}T${nuevaHora}:00-05:00`;
  const { error } = await supabase.from('citas').update({
    fecha_hora: fechaHora,
    estado: 'Confirmada'
  }).eq('id', citaId);

  if (error) throw error;

  // Actualizar en Airtable
  const airtableUrl = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
  const formula = encodeURIComponent(`{ID_Supabase} = '${citaId}'`);
  const searchRes = await axios.get(`${airtableUrl}?filterByFormula=${formula}`, {
    headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
  });

  if (searchRes.data.records.length > 0) {
    const airtableId = searchRes.data.records[0].id;
    await axios.patch(airtableUrl, {
      records: [{
        id: airtableId,
        fields: { "Fecha": nuevaFecha, "Hora": nuevaHora, "Estado": "Confirmada" }
      }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
  }
  return { success: true };
}

async function cancelarCita(citaId) {
  const { error } = await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', citaId);
  if (error) throw error;

  const airtableUrl = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
  const formula = encodeURIComponent(`{ID_Supabase} = '${citaId}'`);
  const searchRes = await axios.get(`${airtableUrl}?filterByFormula=${formula}`, {
    headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
  });

  if (searchRes.data.records.length > 0) {
    const airtableId = searchRes.data.records[0].id;
    await axios.patch(airtableUrl, {
      records: [{ id: airtableId, fields: { "Estado": "Cancelada" } }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
  }
  return { success: true };
}

// ============ WEBHOOK PRINCIPAL ============

app.post('/webhook', async (req, res) => {
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').replace('+', '').trim() : '';
  if (!userPhone) return res.status(200).send('<Response></Response>');

  try {
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const dr = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` } });
      textoUsuario = dr.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 1. Obtener Perfil y Datos
    let { data: cliente } = await supabase.from('clientes').select('*').or(`telefono.eq.${userPhone},telefono.eq.+${userPhone}`).maybeSingle();
    const { data: esp } = await supabase.from('especialistas').select('nombre, rol, expertise');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    const hoy = new Intl.DateTimeFormat('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil' }).format(new Date());

    // 2. Obtener Historial (MEMORIA)
    const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
    const historial = mensajes ? mensajes.reverse() : [];

    // 3. System Prompt Perfeccionado (ELITE PROFILE)
    const systemPrompt = `Eres Aura, la Coordinadora Ejecutiva de AuraSync. No eres un bot, eres una profesional sofisticada, cálida y extremadamente eficiente. Tu misión es que el cliente sienta que está tratando con la mejor asistente personal del mundo.

[TU PERFIL]
- **Lenguaje Impecable**: Usas un español elegante, profesional y cercano. Evitas frases robóticas.
- **Asesora y Persuasiva**: No solo agendas, sino que "vendes" la experiencia. Conoces el expertise de cada especialista y lo usas para recomendar al mejor según el servicio solicitado.
- **Memoria Ejecutiva**: Si el cliente ya mencionó un detalle (servicio, hora, fecha, especialista), NO lo preguntes de nuevo. Úsalo para avanzar.
- **Eficiencia Total**: Tu objetivo es cerrar la cita en el menor número de pasos posible. Si tienes toda la información, confirma de inmediato.
- **Calidez Humana**: Reconoces al cliente por su nombre si ya lo conoces. Si es una conversación fluida, no repitas saludos innecesarios.

[REGLAS DE ORO]
1. **REGISTRO VIP**: Si el cliente es nuevo o le faltan datos (Nombre, Apellido, Ciudad, Fecha de Nacimiento), obtén esta información con elegancia antes de proceder.
2. **ASESORÍA INTELIGENTE**: Usa el campo "expertise" de los especialistas para promoverlos. Ejemplo: "Para ese servicio te recomiendo a Elena, nuestra experta en colorimetría avanzada".
3. **ANTICIPACIÓN**: Si el cliente dice "Corte de pelo mañana a las 10", no preguntes "¿Qué servicio quieres?". Di: "Excelente elección. Mañana a las 10:00 tengo disponibilidad con Ricardo y Elena. ¿Con quién prefieres agendar?".
4. **FLUJO NATURAL**: Si el cliente elige a Elena, no preguntes "¿Qué servicio?". Di: "Perfecto, Elena te atenderá para tu Corte de Cabello Premium mañana a las 10:00. ¿Confirmamos?".
5. **CITAS PARA TERCEROS**: Solo si el cliente menciona explícitamente que la cita es para otra persona, pregunta el nombre. De lo contrario, asume siempre que es para el titular.

[CONTEXTO]
- Especialistas: ${esp?.map(e => `${e.nombre} (${e.rol}: ${e.expertise})`).join(', ')}
- Servicios: ${serv?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ')}
- Horario: 9:00 a 18:00.
- Hoy es ${hoy}.

DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","ciudad":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

    // 4. Llamada a IA con Memoria
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", 
      messages: [
        { role: "system", content: systemPrompt }, 
        ...historial.map(m => ({ role: m.rol, content: m.contenido })), 
        { role: "user", content: textoUsuario }
      ], 
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);

    // 5. Procesamiento de Acciones
    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[1]);
      
      // Registro de Usuario
      if (!cliente && d.nombre !== "..." && d.apellido !== "..." && d.ciudad !== "..." && d.fecha_nacimiento.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const { data: n } = await supabase.from('clientes').upsert({ 
          telefono: userPhone, 
          nombre: d.nombre, 
          apellido: d.apellido, 
          ciudad: d.ciudad,
          fecha_nacimiento: d.fecha_nacimiento 
        }, { onConflict: 'telefono' }).select().single();
        cliente = n;
        finalMessage += `\n\n✅ ¡Bienvenido a AuraSync, ${d.nombre}! Ya estás registrado.`;
      }

      // Acciones de Cita
      if (cliente && d.accion) {
        if (d.accion === 'agendar' && d.cita_fecha !== "..." && d.cita_hora !== "...") {
          const ids = await obtenerIdsRelacionales(d.cita_servicio, d.cita_especialista);
          const disp = await verificarDisponibilidad(d.cita_fecha, d.cita_hora, ids.especialistaId, ids.duracion);
          if (disp.disponible) {
            await registrarCita({ clienteId: cliente.id, telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido, fecha: d.cita_fecha, hora: d.cita_hora, servicio: d.cita_servicio, especialista: d.cita_especialista, servicioId: ids.servicioId, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio });
            if (!finalMessage.includes("confirmada")) finalMessage += `\n\n✅ Cita confirmada con éxito.`;
          } else {
            finalMessage += `\n\n⚠️ ${disp.mensaje}`;
          }
        } else if (d.accion === 'reagendar' && d.cita_fecha !== "..." && d.cita_hora !== "...") {
          const { data: citaProxima } = await supabase.from('citas').select('id').eq('cliente_id', cliente.id).gte('fecha_hora', new Date().toISOString()).eq('estado', 'Confirmada').order('fecha_hora', { ascending: true }).limit(1).maybeSingle();
          if (citaProxima) {
            const ids = await obtenerIdsRelacionales(d.cita_servicio, d.cita_especialista);
            const disp = await verificarDisponibilidad(d.cita_fecha, d.cita_hora, ids.especialistaId, ids.duracion);
            if (disp.disponible) {
              await reagendarCita(citaProxima.id, d.cita_fecha, d.cita_hora);
              finalMessage += `\n\n✅ Tu cita ha sido reprogramada para el ${d.cita_fecha} a las ${d.cita_hora}.`;
            } else {
              finalMessage += `\n\n⚠️ ${disp.mensaje}`;
            }
          } else {
            finalMessage += `\n\n⚠️ No encontré ninguna cita próxima para reprogramar.`;
          }
        } else if (d.accion === 'cancelar') {
          const { data: citaProxima } = await supabase.from('citas').select('id').eq('cliente_id', cliente.id).gte('fecha_hora', new Date().toISOString()).eq('estado', 'Confirmada').order('fecha_hora', { ascending: true }).limit(1).maybeSingle();
          if (citaProxima) {
            await cancelarCita(citaProxima.id);
            finalMessage += `\n\n✅ Tu cita ha sido cancelada correctamente.`;
          } else {
            finalMessage += `\n\n⚠️ No encontré ninguna cita próxima para cancelar.`;
          }
        }
      }
    }

    // 6. Guardar Conversación y Responder
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: finalMessage }]);
    const twiml = new MessagingResponse();
    twiml.message(finalMessage);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  } catch (e) { 
    console.error(e);
    res.status(200).send('<Response><Message>Aura está procesando mucha información, ¿podrías repetirme eso?</Message></Response>'); 
  }
});

app.listen(3000, '0.0.0.0', () => console.log('🚀 AuraSync Online'));
export default app;

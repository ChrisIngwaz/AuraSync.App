import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ DIAGNÓSTICO DE INICIO ============
console.log('🔑 Verificando llaves maestras...');
console.log('- Supabase URL:', process.env.SUPABASE_URL ? '✅ OK' : '❌ FALTANTE');
console.log('- Twilio SID:', process.env.TWILIO_ACCOUNT_SID ? '✅ OK' : '❌ FALTANTE');
console.log('- OpenAI Key:', process.env.OPENAI_API_KEY ? '✅ OK' : '❌ FALTANTE');

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

const twilioClient = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);
const { MessagingResponse } = twilio.twiml;

// ============ UTILIDADES DE TIEMPO ============

function timeToMinutes(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    if (!especialistaId || especialistaId === '...' || especialistaId === 'Asignar') {
      return { disponible: true, mensaje: null };
    }
    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    const HORA_APERTURA = 540;  // 9:00
    const HORA_CIERRE = 1080;   // 18:00

    if (inicioNueva < HORA_APERTURA || finNueva > HORA_CIERRE) {
      return { disponible: false, mensaje: `Nuestro horario es de 9:00 a 18:00.` };
    }

    const { data: citasExistentes } = await supabase
      .from('citas')
      .select('fecha_hora, duracion_aux, servicio_aux')
      .eq('especialista_id', especialistaId)
      .eq('fecha_hora::date', fecha) 
      .in('estado', ['Confirmada', 'En proceso']);

    for (const cita of citasExistentes || []) {
      const horaExistente = cita.fecha_hora.substring(11, 16); 
      const inicioExistente = timeToMinutes(horaExistente);
      const finExistente = inicioExistente + (cita.duracion_aux || 60);
      if (inicioNueva < finExistente && finNueva > inicioExistente) {
        return { disponible: false, mensaje: `Ese espacio ya está reservado.` };
      }
    }
    return { disponible: true, mensaje: null };
  } catch (error) { return { disponible: false, mensaje: "Error agenda." }; }
}

async function obtenerIdsRelacionales(servicioNombre, especialistaNombre) {
  try {
    let servicioId = null, especialistaId = null, duracion = 60, precio = 0;
    if (servicioNombre && servicioNombre !== '...') {
      const { data: serv } = await supabase.from('servicios').select('id, duracion, precio').ilike('nombre', `%${servicioNombre}%`).maybeSingle();
      if (serv) { servicioId = serv.id; duracion = serv.duracion || 60; precio = serv.precio || 0; }
    }
    if (especialistaNombre && especialistaNombre !== '...' && especialistaNombre !== 'Asignar') {
      const { data: esp } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialistaNombre}%`).maybeSingle();
      if (esp) especialistaId = esp.id;
    }
    return { servicioId, especialistaId, duracion, precio };
  } catch (error) { return { servicioId: null, especialistaId: null, duracion: 60, precio: 0 }; }
}

async function buscarCitaProxima(clienteId) {
  const { data } = await supabase.from('citas').select('*').eq('cliente_id', clienteId).gte('fecha_hora', new Date().toISOString()).in('estado', ['Confirmada', 'En proceso']).order('fecha_hora', { ascending: true }).limit(1).maybeSingle();
  return data;
}

async function actualizarCita(citaId, nuevosDatos) {
  try {
    const fechaHora = `${nuevosDatos.fecha}T${nuevosDatos.hora}:00`;
    await supabase.from('citas').update({ servicio_id: nuevosDatos.servicioId, especialista_id: nuevosDatos.especialistaId, fecha_hora: fechaHora, servicio_aux: nuevosDatos.servicio, duracion_aux: nuevosDatos.duracion }).eq('id', citaId);

    const formula = encodeURIComponent(`AND({Teléfono} = '${nuevosDatos.telefono}', {Estado} = 'Confirmada')`);
    const searchRes = await axios.get(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });

    if (searchRes.data.records?.length > 0) {
      await axios.patch(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}/${searchRes.data.records[0].id}`, {
        fields: { "Servicio": nuevosDatos.servicio, "Fecha": fechaHora, "Hora": nuevosDatos.hora, "Especialista": nuevosDatos.especialista, "Importe estimado": nuevosDatos.precio, "Duración estimada (minutos)": nuevosDatos.duracion }
      }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    }
    return { success: true };
  } catch (error) { return { success: false }; }
}

async function cancelarCita(citaId, telefono) {
  try {
    await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', citaId);
    const formula = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const searchRes = await axios.get(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    if (searchRes.data.records?.length > 0) {
      await axios.patch(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}/${searchRes.data.records[0].id}`, { fields: { "Estado": "Cancelada" } }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    }
    return { success: true };
  } catch (error) { return { success: false }; }
}

async function registrarCita(datos) {
  try {
    const fechaHora = `${datos.fecha}T${datos.hora}:00`;
    const { data } = await supabase.from('citas').insert({ cliente_id: datos.clienteId, servicio_id: datos.servicioId, especialista_id: datos.especialistaId, fecha_hora: fechaHora, estado: 'Confirmada', nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(), servicio_aux: datos.servicio, duracion_aux: datos.duracion }).select().single();

    await axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
      records: [{ fields: { "ID_Supabase": data.id, "Cliente": `${datos.nombre} ${datos.apellido}`.trim(), "Servicio": datos.servicio, "Fecha": fechaHora, "Hora": datos.hora, "Especialista": datos.especialista, "Teléfono": datos.telefono, "Estado": "Confirmada", "Importe estimado": datos.precio, "Duración estimada (minutos)": datos.duracion } }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { success: true };
  } catch (error) { return { success: false }; }
}

// ============ WEBHOOK PRINCIPAL ============

app.get('/webhook', (req, res) => res.status(200).send('AuraSync Webhook is Active! 🚀'));
app.get('/', (req, res) => res.status(200).send('AuraSync Server is Running! 🚀'));

app.post('*', async (req, res) => {
  console.log('📩 ¡LLEGÓ UN MENSAJE!');
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : '';
  if (!userPhone) return res.status(200).send('<Response></Response>');

  try {
    let textoUsuario = Body || "";
    let finalMessage = "";

    if (MediaUrl0) {
      console.log('🎙️ Procesando audio:', MediaUrl0);
      try {
        const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' } });
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('📝 Transcripción:', textoUsuario);
      } catch (error) {
        console.error('❌ Error Deepgram:', error.response?.data || error.message);
        finalMessage = "Lo siento, no pude escuchar bien el audio. ¿Me lo escribes?";
      }
    }

    if (!finalMessage) {
      let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
      const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(10);
      const historial = mensajes ? mensajes.reverse() : [];
      const { data: especialistas } = await supabase.from('especialistas').select('*');
      const { data: servicios } = await supabase.from('servicios').select('*');

      const systemPrompt = `Eres Aura, Coordinadora de AuraSync. Hoy es ${new Date().toLocaleDateString('es-EC')}. 
      Servicios: ${servicios?.map(s => s.nombre).join(', ')}. Especialistas: ${especialistas?.map(e => e.nombre).join(', ')}.
      Si el cliente es nuevo, pide Nombre, Apellido y Fecha Nacimiento (YYYY-MM-DD).
      SALIDA JSON: DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...historial.map(m => ({ role: m.rol, content: m.contenido })), { role: "user", content: textoUsuario }],
        temperature: 0.3
      }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

      fullReply = aiRes.data.choices[0].message.content;
      finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
      const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);

      if (jsonMatch) {
        const datos = JSON.parse(jsonMatch[1]);
        if (datos.nombre !== "..." && datos.fecha_nacimiento.match(/^\d{4}/)) {
          const { data: u } = await supabase.from('clientes').upsert({ telefono: userPhone, nombre: datos.nombre, apellido: datos.apellido, fecha_nacimiento: datos.fecha_nacimiento }, { onConflict: 'telefono' }).select().single();
          cliente = u;
        }
        if (cliente && datos.accion) {
          const citaEx = await buscarCitaProxima(cliente.id);
          if (datos.accion === 'cancelar' && citaEx) await cancelarCita(citaEx.id, userPhone);
          else if (datos.cita_fecha.match(/^\d{4}/)) {
            const ids = await obtenerIdsRelacionales(datos.cita_servicio, datos.cita_especialista);
            const disp = await verificarDisponibilidad(datos.cita_fecha, datos.cita_hora, ids.especialistaId, ids.duracion);
            if (disp.disponible) {
              if (datos.accion === 'reagendar' && citaEx) await actualizarCita(citaEx.id, { ...datos, clienteId: cliente.id, telefono: userPhone, ...ids, fecha: datos.cita_fecha, hora: datos.cita_hora });
              else await registrarCita({ ...datos, clienteId: cliente.id, telefono: userPhone, ...ids, fecha: datos.cita_fecha, hora: datos.cita_hora });
            } else finalMessage += `\n\n${disp.mensaje}`;
          }
        }
      }
    }

    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: finalMessage }]);
    const twiml = new MessagingResponse();
    twiml.message(finalMessage);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(twiml.toString());
  } catch (err) {
    const twiml = new MessagingResponse();
    twiml.message('Error técnico. Intenta de nuevo.');
    res.status(200).send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 AuraSync Online`));

export default app;

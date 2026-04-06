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
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
  AIRTABLE_SYNC_TOKEN: process.env.AIRTABLE_SYNC_TOKEN || 'aura_secure_sync_2024'
};

const { MessagingResponse } = twilio.twiml;
const twilioClient = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);

// ============ UTILIDADES DE TIEMPO ============

function timeToMinutes(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

// ============ FUNCIONES DE APOYO ============

async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    if (!especialistaId || especialistaId === '...' || especialistaId === 'Asignar') return { disponible: true };
    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    
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
      if (inicioNueva < finExistente && finNueva > inicioExistente) return { disponible: false, mensaje: `Ese espacio ya está reservado para una ${cita.servicio_aux}.` };
    }
    return { disponible: true };
  } catch (error) { return { disponible: false, mensaje: "Error de agenda." }; }
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

async function buscarCitaProxima(clienteId) {
  const { data } = await supabase.from('citas').select('*').eq('cliente_id', clienteId).gte('fecha_hora', new Date().toISOString()).in('estado', ['Confirmada', 'En proceso']).order('fecha_hora', { ascending: true }).limit(1).maybeSingle();
  return data;
}

async function registrarCita(datos) {
  const fechaHora = `${datos.fecha}T${datos.hora}:00-05:00`;
  const { data, error } = await supabase.from('citas').insert({
    cliente_id: datos.clienteId, servicio_id: datos.servicioId, especialista_id: datos.especialistaId,
    fecha_hora: fechaHora, estado: 'Confirmada', nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(),
    servicio_aux: datos.servicio, duracion_aux: datos.duracion
  }).select().single();
  if (error) throw error;

  await axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
    records: [{ fields: { "ID_Supabase": data.id, "Cliente": `${datos.nombre} ${datos.apellido}`.trim(), "Servicio": datos.servicio, "Fecha": fechaHora, "Hora": datos.hora, "Especialista": datos.especialista, "Teléfono": datos.telefono, "Estado": "Confirmada", "Importe estimado": datos.precio, "Duración estimada (minutos)": datos.duracion } }]
  }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
  return { success: true, id: data.id };
}

// ============ ENDPOINTS DE AUTOMATIZACIÓN ============

app.get('/api/reporte-diario', async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const { data: citas } = await supabase.from('citas').select('servicio_aux, duracion_aux').gte('fecha_hora', `${hoy}T00:00:00`).lte('fecha_hora', `${hoy}T23:59:59`).eq('estado', 'Confirmada');
    const total = citas?.length || 0;
    const resumen = `📊 *Reporte AuraSync - ${hoy}*\n- Citas totales: ${total}\n- Estado: Operativo`;
    await twilioClient.messages.create({ body: resumen, from: `whatsapp:+${CONFIG.TWILIO_PHONE_NUMBER}`, to: `whatsapp:+593987654321` });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recordatorios', async (req, res) => {
  try {
    const mañana = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const { data: citas } = await supabase.from('citas').select('*, clientes(telefono, nombre)').gte('fecha_hora', `${mañana}T00:00:00`).lte('fecha_hora', `${mañana}T23:59:59`).eq('estado', 'Confirmada');
    for (const c of citas || []) {
      const msg = `Hola ${c.clientes.nombre}, Aura te recuerda tu cita de mañana a las ${c.fecha_hora.split('T')[1].substring(0, 5)} para ${c.servicio_aux}. ¡Te esperamos!`;
      await twilioClient.messages.create({ body: msg, from: `whatsapp:+${CONFIG.TWILIO_PHONE_NUMBER}`, to: `whatsapp:+${c.clientes.telefono}` });
    }
    res.json({ success: true, enviados: citas?.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/airtable-sync', async (req, res) => {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${CONFIG.AIRTABLE_SYNC_TOKEN}`) return res.status(401).json({ error: 'No autorizado' });
  const { id_supabase, fecha, hora, especialista, servicio, estado } = req.body;
  if (!id_supabase) return res.status(400).json({ error: 'Falta ID_Supabase' });
  try {
    const updates = {};
    if (fecha && hora) updates.fecha_hora = `${fecha}T${hora}:00-05:00`;
    if (servicio) updates.servicio_aux = servicio;
    if (estado) updates.estado = estado;
    if (especialista) {
      const { data: esp } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialista}%`).maybeSingle();
      if (esp) updates.especialista_id = esp.id;
    }
    await supabase.from('citas').update(updates).eq('id', id_supabase);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ WEBHOOK PRINCIPAL ============

app.post('*', async (req, res) => {
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
1. **ASESORÍA INTELIGENTE**: Usa el campo "expertise" de los especialistas para promoverlos. Si alguien pide un servicio, di algo como: "Para ese servicio te recomiendo a [Nombre], es nuestra experta en [Expertise]".
2. **ANTICIPACIÓN**: Si el cliente dice "Corte de pelo mañana a las 10", no preguntes "¿Qué servicio quieres?". Di: "Excelente elección. Mañana a las 10:00 tengo disponibilidad con Ricardo y Elena. ¿Con quién prefieres agendar?".
3. **FLUJO NATURAL**: Si el cliente elige a Elena, no preguntes "¿Qué servicio?". Di: "Perfecto, Elena te atenderá para tu Corte de Cabello Premium mañana a las 10:00. ¿Confirmamos?".
4. **DATOS DEL CLIENTE**: Si ya conoces a ${cliente ? cliente.nombre : 'el cliente'}, trátalo como un invitado VIP. No pidas datos que ya tenemos.
5. **CITAS PARA TERCEROS**: Solo si el cliente menciona explícitamente que la cita es para otra persona, pregunta el nombre para anotarlo. De lo contrario, asume siempre que la cita es para el titular que escribe. No inventes que la cita es para un hijo si no se ha mencionado.

[CONTEXTO]
- Especialistas: ${esp?.map(e => `${e.nombre} (${e.rol}: ${e.expertise})`).join(', ')}
- Servicios: ${serv?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ')}
- Horario: 9:00 a 18:00.
- Hoy es ${hoy}.

DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

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
      if (!cliente && d.nombre !== "...") {
        const { data: n } = await supabase.from('clientes').upsert({ telefono: userPhone, nombre: d.nombre, apellido: d.apellido, fecha_nacimiento: d.fecha_nacimiento }, { onConflict: 'telefono' }).select().single();
        cliente = n;
      }
      if (cliente && d.accion && d.cita_fecha !== "..." && d.cita_hora !== "...") {
        const ids = await obtenerIdsRelacionales(d.cita_servicio, d.cita_especialista);
        const disp = await verificarDisponibilidad(d.cita_fecha, d.cita_hora, ids.especialistaId, ids.duracion);
        if (disp.disponible) {
          await registrarCita({ clienteId: cliente.id, telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido, fecha: d.cita_fecha, hora: d.cita_hora, servicio: d.cita_servicio, especialista: d.cita_especialista, servicioId: ids.servicioId, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio });
          if (!finalMessage.includes("confirmada")) finalMessage += `\n\n✅ Cita confirmada con éxito.`;
        } else if (disp.mensaje) {
          finalMessage += `\n\n${disp.mensaje}`;
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

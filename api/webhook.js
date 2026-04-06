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

// ============ ENDPOINTS DE AUTOMATIZACIÓN (REPORTES Y RECORDATORIOS) ============

app.get('/api/reporte-diario', async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const { data: citas } = await supabase.from('citas').select('servicio_aux, duracion_aux').gte('fecha_hora', `${hoy}T00:00:00`).lte('fecha_hora', `${hoy}T23:59:59`).eq('estado', 'Confirmada');
    const total = citas?.length || 0;
    const resumen = `📊 *Reporte AuraSync - ${hoy}*\n- Citas totales: ${total}\n- Estado: Operativo`;
    await twilioClient.messages.create({ body: resumen, from: `whatsapp:+${CONFIG.TWILIO_PHONE_NUMBER}`, to: `whatsapp:+593987654321` }); // Cambiar al número del dueño
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

// ============ SINCRONIZACIÓN AIRTABLE -> SUPABASE ============

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
      const dr = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` } });
      textoUsuario = dr.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    let { data: cliente } = await supabase.from('clientes').select('*').or(`telefono.eq.${userPhone},telefono.eq.+${userPhone}`).maybeSingle();
    const { data: esp } = await supabase.from('especialistas').select('nombre, rol, expertise');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    const hoy = new Intl.DateTimeFormat('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil' }).format(new Date());

    const systemPrompt = `Eres Aura, la Coordinadora Ejecutiva de AuraSync. Eres la mano derecha de nuestros especialistas y la guía de confianza de nuestros clientes. Hablas con ${cliente ? cliente.nombre : 'un cliente nuevo'} (${userPhone}).

[TU PERSONALIDAD]
- **Humana y Sofisticada**: Hablas con seguridad y calidez. Eres extremadamente eficiente.
- **Persuasiva**: "Vendes" la experiencia. Destaca el expertise de los especialistas.
- **Proactiva**: Si un horario está ocupado, ofrece inmediatamente la mejor alternativa.
- **Lenguaje**: Usa "nosotros", "nuestro equipo", "te he reservado".

[REGLAS DE ORO]
1. **SI YA EXISTE**: Tienes terminantemente PROHIBIDO pedirle su nombre, apellido o fecha de nacimiento. Ya es parte de la casa. Salúdalo con calidez y pasa directo a su solicitud.
2. **SI ES NUEVO**: Tu prioridad es obtener su Nombre, Apellido y Fecha de Nacimiento (YYYY-MM-DD) con elegancia antes de agendar.
3. **CITAS PARA TERCEROS**: Si agenda para un hijo o amigo, pregunta el nombre de esa persona para la cita, pero aclara que el perfil del teléfono seguirá siendo del titular. NO intentes registrar un nuevo perfil.
4. **AGENDA**: Horario 9:00 a 18:00. Especialistas: ${esp?.map(e=>e.nombre).join(', ')}. Servicios: ${serv?.map(s=>s.nombre).join(', ')}.

Hoy es ${hoy}.
DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoUsuario }], temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);

    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[1]);
      if (!cliente && d.nombre !== "...") {
        const { data: n } = await supabase.from('clientes').upsert({ telefono: userPhone, nombre: d.nombre, apellido: d.apellido, fecha_nacimiento: d.fecha_nacimiento }, { onConflict: 'telefono' }).select().single();
        cliente = n;
      }
      if (cliente && d.accion) {
        const ids = await obtenerIdsRelacionales(d.cita_servicio, d.cita_especialista);
        const disp = await verificarDisponibilidad(d.cita_fecha, d.cita_hora, ids.especialistaId, ids.duracion);
        if (disp.disponible) {
          await registrarCita({ clienteId: cliente.id, telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido, fecha: d.cita_fecha, hora: d.cita_hora, servicio: d.cita_servicio, especialista: d.cita_especialista, servicioId: ids.servicioId, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio });
          finalMessage += `\n\n✅ Cita confirmada.`;
        } else { finalMessage += `\n\n${disp.mensaje}`; }
      }
    }

    const twiml = new MessagingResponse();
    twiml.message(finalMessage);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  } catch (e) { res.status(200).send('<Response><Message>Error técnico.</Message></Response>'); }
});

app.listen(3000, '0.0.0.0', () => console.log('🚀 AuraSync Online'));
export default app;

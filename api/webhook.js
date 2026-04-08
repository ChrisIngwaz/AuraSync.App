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

app.get(['/', '/webhook', '/api/webhook'], (req, res) => {
  res.status(200).send('🚀 AuraSync Online - Webhook listo.');
});

app.post(['/', '/webhook', '/api/webhook'], async (req, res) => {
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').replace('+', '').trim() : '';
  
  console.log(`[INCOMING] Mensaje de: ${userPhone}`);

  if (!userPhone) return res.status(200).send('<Response></Response>');

  try {
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      console.log('🎙️ Procesando audio...');
      const dr = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true", 
        { url: MediaUrl0 }, 
        { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      textoUsuario = dr.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      console.log(`📝 Audio transcrito: "${textoUsuario}"`);
    }

    // 1. Datos de Contexto
    let { data: cliente } = await supabase.from('clientes').select('*').or(`telefono.eq.${userPhone},telefono.eq.+${userPhone}`).maybeSingle();
    const { data: esp } = await supabase.from('especialistas').select('nombre, rol, expertise');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    const hoy = new Intl.DateTimeFormat('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil' }).format(new Date());

    // 2. Memoria
    const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
    const historial = mensajes ? mensajes.reverse() : [];

    // 3. System Prompt (REFORZADO PARA REGISTRO)
    const systemPrompt = `Eres Aura, la Coordinadora Ejecutiva de AuraSync. Tu misión es agendar citas con elegancia y eficiencia.

[REGLAS CRÍTICAS DE REGISTRO]
- Si el cliente confirma una cita, DEBES llenar el DATA_JSON con la fecha, hora, servicio y especialista REALES.
- NO uses "..." en el JSON si el dato ya se mencionó en la charla.
- Si el cliente dice "hoy", traduce eso a la fecha actual en formato YYYY-MM-DD.
- Solo considera la cita como "agendada" cuando tengas: Fecha, Hora, Servicio y Especialista.

[TU PERFIL]
- Profesional, sofisticada y cálida.
- Si el cliente es nuevo, pide Nombre, Apellido, Ciudad y Fecha de Nacimiento (YYYY-MM-DD) antes de agendar.

[CONTEXTO]
- Especialistas: ${esp?.map(e => `${e.nombre} (${e.rol}: ${e.expertise})`).join(', ')}
- Servicios: ${serv?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ')}
- Horario: 9:00 a 18:00.
- Hoy es ${hoy}.

DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","ciudad":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

    // 4. IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", 
      messages: [
        { role: "system", content: systemPrompt }, 
        ...historial.map(m => ({ role: m.rol, content: m.contenido })), 
        { role: "user", content: textoUsuario }
      ], 
      temperature: 0.2
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);

    // 5. Procesamiento de Datos
    if (jsonMatch) {
      try {
        const d = JSON.parse(jsonMatch[1]);
        console.log('📦 Datos detectados:', d);
        
        // Registro de Cliente
        if (!cliente && d.nombre !== "..." && d.apellido !== "..." && d.fecha_nacimiento?.match(/^\d{4}-\d{2}-\d{2}$/)) {
          console.log('👤 Registrando cliente VIP...');
          const { data: n } = await supabase.from('clientes').upsert({ 
            telefono: userPhone, nombre: d.nombre, apellido: d.apellido, ciudad: d.ciudad, fecha_nacimiento: d.fecha_nacimiento 
          }, { onConflict: 'telefono' }).select().single();
          cliente = n;
        }

        // Acciones de Cita
        if (cliente && d.accion) {
          if (d.accion === 'agendar' && d.cita_fecha !== "..." && d.cita_hora !== "...") {
            console.log('📅 Procesando registro de cita...');
            const ids = await obtenerIdsRelacionales(d.cita_servicio, d.cita_especialista);
            const disp = await verificarDisponibilidad(d.cita_fecha, d.cita_hora, ids.especialistaId, ids.duracion);
            
            if (disp.disponible) {
              const success = await registrarCita({ 
                clienteId: cliente.id, telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido, 
                fecha: d.cita_fecha, hora: d.cita_hora, servicio: d.cita_servicio || 'Servicio General', 
                especialista: d.cita_especialista || 'Asignar', servicioId: ids.servicioId, 
                especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio 
              });
              
              if (success) {
                finalMessage += `\n\n✅ ¡Listo! Tu cita ha quedado confirmada. Te esperamos.`;
                console.log('✅ Cita registrada en todos los sistemas.');
              }
            } else {
              finalMessage += `\n\n⚠️ ${disp.mensaje}`;
            }
          }
          // Reagendar y Cancelar siguen lógica similar...
        }
      } catch (err) { console.error('❌ Error procesando JSON:', err.message); }
    }

    // 6. Respuesta
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: finalMessage }]);
    const twiml = new MessagingResponse();
    twiml.message(finalMessage);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());

  } catch (e) { 
    console.error('❌ Error crítico:', e.message);
    res.status(200).send('<Response><Message>Aura está teniendo un momento de alta demanda, ¿podrías repetirme eso?</Message></Response>'); 
  }
});

// ============ FUNCIONES DE APOYO ============

async function registrarCita(datos) {
  try {
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

    // Sincronización con Airtable (No bloqueante para Supabase)
    axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
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
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } }).catch(e => console.error('Airtable Sync Error:', e.message));

    return true;
  } catch (e) {
    console.error('Error registrarCita:', e.message);
    return false;
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

function timeToMinutes(hora) {
  if (!hora || typeof hora !== 'string') return 0;
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    if (!especialistaId) return { disponible: true };
    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    if (inicioNueva < 540 || finNueva > 1080) return { disponible: false, mensaje: "Fuera de horario (9:00-18:00)." };
    const { data: citas } = await supabase.from('citas').select('fecha_hora, duracion_aux').eq('especialista_id', especialistaId).gte('fecha_hora', `${fecha}T00:00:00`).lte('fecha_hora', `${fecha}T23:59:59`).in('estado', ['Confirmada', 'En proceso']);
    for (const c of citas || []) {
      const hEx = c.fecha_hora.split('T')[1].substring(0, 5);
      const iEx = timeToMinutes(hEx);
      const fEx = iEx + (c.duracion_aux || 60);
      if (inicioNueva < fEx && finNueva > iEx) return { disponible: false, mensaje: "El especialista ya tiene una cita a esa hora." };
    }
    return { disponible: true };
  } catch (e) { return { disponible: true }; }
}

app.post('/api/sync-airtable', syncAirtable);
app.get('/api/daily-report', dailyReport);
app.get('/api/reminders', reminders);

// Exportar para Vercel
export default app;

// Solo escuchar si no estamos en Vercel
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, '0.0.0.0', () => console.log('🚀 AuraSync Local en puerto 3000'));
}

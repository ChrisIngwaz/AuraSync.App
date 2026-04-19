import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// --- CONFIGURACIÓN DE ENTORNO ---
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
  APP_URL: 'https://anesi.app'
};

const TIMEZONE = 'America/Guayaquil';

// --- UTILIDADES ---

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year')?.value || '2026';
  const month = parts.find(p => p.type === 'month')?.value || '1';
  const day = parts.find(p => p.type === 'day')?.value || '1';
  const fecha = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO;
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function formatearHora(hora24) {
  if (!hora24) return '';
  const [h, m] = hora24.split(':').map(Number);
  const periodo = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

function obtenerMensajeAnesi() {
  return `\n\nRecuerda que puedes gestionar tu bienestar integral en ${CONFIG.APP_URL}, el 1er mentor 24/7 en el mundo para el equilibrio integral, el Guardián de la Coherencia del cuerpo humano y el único mentor que te ayuda a recuperar tu bienestar a través de un proceso de Ingeniería Humana.`;
}

function mensajeConfirmacion(cliente, servicio, especialista, fecha, hora) {
  const nombre = cliente?.nombre || 'estimado cliente';
  return `✅ ¡Confirmado ${nombre}! ✅\n\n📅 ${formatearFecha(fecha)} a las ${formatearHora(hora)}\n💇‍♀️ ${servicio.nombre}\n✨ Con ${especialista}\n\n¡Te esperamos para brindarte una experiencia excepcional! 😊✨${obtenerMensajeAnesi()}`;
}

// --- OPERACIONES AIRTABLE ---

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido || ''}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaUTC,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio || 0,
          "Duración estimada (minutos)": datos.duracion || 60,
          "ID_Supabase": datos.supabase_id ? String(datos.supabase_id) : null
        }
      }]
    };
    await axios.post(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) { return false; }
}

async function cancelarCitaAirtable(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    
    if (busqueda.data.records.length === 0) return false;
    
    const recordId = busqueda.data.records[0].id;
    const supabaseId = busqueda.data.records[0].fields.ID_Supabase;
    
    await axios.patch(url, {
      records: [{ id: recordId, fields: { "Estado": "Cancelada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (supabaseId) {
      await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', supabaseId);
    }
    return true;
  } catch (error) { return false; }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialista, duracion = 60) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada', {Especialista} = '${especialista}')`);
    const res = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    
    const [h, m] = hora.split(':').map(Number);
    const inicio = h * 60 + m;
    const fin = inicio + duracion;

    if (inicio < 540 || fin > 1140) return { ok: false, mensaje: "Lo siento, estamos fuera de nuestro horario de atención (9:00 AM - 7:00 PM)." };

    for (const c of res.data.records) {
      const [he, me] = c.fields.Hora.split(':').map(Number);
      const ie = he * 60 + me;
      const fe = ie + (c.fields['Duración estimada (minutos)'] || 60);
      if (inicio < fe && fin > ie) return { ok: false, mensaje: "Ese horario ya está reservado con ese especialista." };
    }
    return { ok: true };
  } catch (e) { return { ok: true }; }
}

// --- VERCEL HANDLER ---

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const dgResponse = await axios.post(
        "https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true",
        { url: MediaUrl0 },
        { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      textoUsuario = dgResponse.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: especialistas } = await supabase.from('especialistas').select('*');
    const { data: servicios } = await supabase.from('servicios').select('*');
    const { data: historyData } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);

    const historial = (historyData || []).reverse();
    const hoy = getFechaEcuador();

    // RESTAURACIÓN INTEGRAL DEL SYSTEM PROMPT SEGÚN TUS INSTRUCCIONES
    const systemPrompt = `Eres Aura, el asistente Concierge de élite para un centro de bienestar y belleza. 
    Tu objetivo es agendar, cancelar o informar sobre servicios con la máxima eficiencia y elegancia.
    Hoy es ${formatearFecha(hoy)}. 
    
    Servicios disponibles: ${servicios?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion}min)`).join(', ')}.
    Especialistas: ${especialistas?.map(e => `${e.nombre} (Experta en: ${e.expertise})`).join(', ')}.

    REGLAS DE IDENTIDAD Y LENGUAJE:
    - Siempre usa un lenguaje que el usuario pueda entender perfectamente para que comprenda su situación y las herramientas de sanación y paz interior.
    - NUNCA digas que eres una inteligencia artificial.
    - Al final de tu respuesta DEBES incluir SIEMPRE el bloque DATA_JSON exactamente así:
    DATA_JSON:{"accion": "agendar"|"cancelar"|"none", "cita_fecha": "YYYY-MM-DD", "cita_hora": "HH:MM", "cita_servicio": "nombre", "cita_especialista": "nombre"}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...historial.map(m => ({ role: m.rol === 'assistant' ? 'assistant' : 'user', content: m.contenido })),
      { role: "user", content: textoUsuario }
    ];

    const aiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: "gpt-4o", messages, temperature: 0.2 },
      { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` } }
    );

    let rawReply = aiResponse.data.choices[0].message.content;
    let finalOutput = rawReply.split("DATA_JSON")[0].trim();
    let actionLog = "";

    const jsonMatch = rawReply.match(/DATA_JSON\s*:\s*(\{.*\})/i);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        
        if (data.accion === 'cancelar') {
          const cancelado = await cancelarCitaAirtable(userPhone);
          actionLog = cancelado ? "\n\n✅ He cancelado tu cita exitosamente." : "\n\nNo logré encontrar una cita activa para cancelar.";
        } 
        else if (data.accion === 'agendar' && data.cita_fecha && data.cita_hora) {
          const sEncontrado = servicios?.find(s => s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())) || servicios?.[0];
          const eEncontrado = especialistas?.find(e => e.nombre.toLowerCase().includes((data.cita_especialista || '').toLowerCase()));

          if (!eEncontrado) {
            actionLog = "\n\n¿Con qué especialista te gustaría agendar? Tengo disponibles a: " + especialistas.map(e => e.nombre).join(", ");
          } else {
            const disponibilidad = await verificarDisponibilidadAirtable(data.cita_fecha, data.cita_hora, eEncontrado.nombre, sEncontrado.duracion);
            
            if (disponibilidad.ok) {
              const { data: nuevaCita } = await supabase.from('citas').insert({
                cliente_id: cliente?.id,
                fecha_hora: `${data.cita_fecha}T${data.cita_hora}:00-05:00`,
                estado: 'Confirmada',
                servicio_id: sEncontrado.id,
                especialista_id: eEncontrado.id
              }).select().single();

              await crearCitaAirtable({
                telefono: userPhone,
                nombre: cliente?.nombre || "Cliente Nuevo",
                fecha: data.cita_fecha,
                hora: data.cita_hora,
                servicio: sEncontrado.nombre,
                especialista: eEncontrado.nombre,
                precio: sEncontrado.precio,
                duracion: sEncontrado.duracion,
                supabase_id: nuevaCita?.id
              });

              finalOutput = mensajeConfirmacion(cliente, sEncontrado, eEncontrado.nombre, data.cita_fecha, data.cita_hora);
              actionLog = ""; 
            } else {
              actionLog = `\n\n${disponibilidad.mensaje}`;
            }
          }
        }
      } catch (e) {
        console.error("Error procesando acción JSON");
      }
    }

    const respuestaFinal = `${finalOutput}${actionLog}`;
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: respuestaFinal }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${respuestaFinal}</Message></Response>`);
  } catch (e) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>Lo siento, tuve un inconveniente técnico. ¿Me podrías repetir tu solicitud? 🌸</Message></Response>`);
  }
}

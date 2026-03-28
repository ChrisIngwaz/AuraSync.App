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
    // 1. PROCESAR TEXTO/AUDIO
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const dgRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, 
        { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` } });
      textoUsuario = dgRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. CARGAR CLIENTE
    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const esNuevo = !cliente?.nombre;
    const primerNombre = cliente?.nombre?.split(' ')[0] || null;

    // 3. DATOS DE NEGOCIO
    const { data: esp } = await supabase.from('especialistas').select('nombre');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio');
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = serv?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";

    // 4. LÓGICA TEMPORAL Y PROMPT DE VENTA CONSULTIVA
    const ahora = new Date();
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil'
    }).format(ahora);
    const anioActual = ahora.getFullYear();

    const systemPrompt = `Eres Aura, asesora de imagen de élite en AuraSync. Tu tono es ejecutivo y profesional.
    
    [CONTEXTO]
    Hoy es ${hoyEcuador}. Año: ${anioActual}.
    Cliente: ${cliente?.nombre || 'Nuevo'}. Registro: ${esNuevo ? 'PENDIENTE' : 'COMPLETO'}.

    [ESTRATEGIA DE VENTA]
    1. Si piden cita de corte, haz una pregunta diagnóstica: "¿Hace cuánto no cortas tus puntas?" o "¿Cómo sientes la vitalidad de tu cabello?".
    2. Basado en su respuesta, sugiere un tratamiento (ej. Hidratación Profunda) para "recuperar la salud de las puntas" antes de confirmar la cita.
    3. RECOMIENDA: No seas neutral. "Le sugiero a Elena, es nuestra experta en recuperación capilar".

    [REGLA TÉCNICA CRÍTICA]
    Aunque estés asesorando, DEBES llenar el DATA_JSON con la mejor suposición de lo que el cliente quiere agendar (servicio, fecha, hora) para que el sistema lo registre.

    DATA_JSON:{
      "nombre": "${cliente?.nombre || ''}",
      "apellido": "${cliente?.apellido || ''}",
      "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
      "cita_fecha": "YYYY-MM-DD",
      "cita_hora": "HH:MM",
      "cita_servicio": "...",
      "cita_especialista": "..."
    }`;

    // 5. OPENAI
    const { data: hist } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
    const messages = [{ role: "system", content: systemPrompt }];
    if (hist && !esNuevo) hist.reverse().forEach(m => messages.push({ role: m.rol === 'assistant' ? 'assistant' : 'user', content: m.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', { model: "gpt-4o", messages, temperature: 0.4 }, 
      { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` } });

    const fullReply = aiRes.data.choices[0].message.content;
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();

    // 6. EXTRACCIÓN Y REGISTRO (EL MOTOR QUE FALLABA)
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    let citaCreada = false;

    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[1]);
      
      // Actualizar Cliente
      if (d.nombre && d.nombre !== "..." && esNuevo) {
        await supabase.from('clientes').upsert({
          telefono: userPhone, nombre: d.nombre, apellido: d.apellido || "", fecha_nacimiento: d.fecha_nacimiento !== "..." ? d.fecha_nacimiento : null
        });
        cliente = { nombre: d.nombre, apellido: d.apellido };
      }

      // Validar Cita para Airtable
      const tieneFecha = d.cita_fecha && d.cita_fecha.includes('-');
      const tieneHora = d.cita_hora && d.cita_hora.includes(':');
      const tieneServicio = d.cita_servicio && d.cita_servicio !== "...";

      if (tieneFecha && tieneHora && tieneServicio && (cliente?.nombre || d.nombre)) {
        citaCreada = await crearCitaAirtable({
          telefono: userPhone,
          nombre: cliente?.nombre || d.nombre,
          apellido: cliente?.apellido || d.apellido || "",
          fecha: d.cita_fecha,
          hora: d.cita_hora,
          servicio: d.cita_servicio,
          especialista: d.cita_especialista !== "..." ? d.cita_especialista : "Por asignar"
        });
      }
    }

    if (citaCreada) cleanReply += "\n\n✅ Cita registrada.";

    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);
    
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    return res.status(200).send('<Response><Message>Lo siento, tuve un inconveniente técnico. ¿Podrías repetir eso?</Message></Response>');
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    await axios.post(url, {
      records: [{ fields: {
        "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
        "Servicio": datos.servicio,
        "Fecha": datos.fecha,
        "Hora": datos.hora,
        "Especialista": datos.especialista,
        "Teléfono": datos.telefono,
        "Estado": "Confirmada"
      }}]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }});
    return true;
  } catch (e) { return false; }
}

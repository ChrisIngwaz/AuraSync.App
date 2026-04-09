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

// NUEVA FUNCIÓN: Para que Aura no invente datos
async function buscarCitasActivasAirtable(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const res = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    return res.data.records.map(r => ({
      servicio: r.fields.Servicio,
      fecha: r.fields.Hora, // En Airtable solemos tener el campo Hora como texto o la fecha completa
      especialista: r.fields.Especialista,
      hora: r.fields.Hora
    }));
  } catch (e) { return []; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  try {
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` }});
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    
    // OBTENEMOS CITAS REALES PARA EL PROMPT
    const citasReales = await buscarCitasActivasAirtable(userPhone);
    const infoCitas = citasReales.length > 0 
      ? citasReales.map(c => `- ${c.servicio} con ${c.especialista} a las ${c.hora} (Hoy)`).join('\n')
      : "El cliente no tiene citas agendadas actualmente.";

    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    const listaEsp = especialistas?.map(e => `${e.nombre} (${e.expertise})`).join(', ');
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ');

    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Concierge de lujo.

[CITAS ACTUALES DEL CLIENTE]
${infoCitas}

[IDENTIDAD]
- Tono: Sofisticado, cálido y humano.
- IMPORTANTE: Si el cliente pregunta por su cita, NO inventes la hora. Usa la información de [CITAS ACTUALES DEL CLIENTE].
- FLUJO DE MENSAJES: Para parecer humana, si vas a verificar algo, divide tu respuesta en dos partes usando el separador "###". 
  Ejemplo: "¡Hola, Chris! Claro, déjame verificar eso para ti. ### Tienes un corte de cabello agendado para hoy a las 17:00."

[REGLAS DE ORO]
- Si recomiendas a alguien, espera a que el cliente acepte antes de agendar (accion: "none").
- NUNCA escribas el checkmark (✅) tú misma.
- Sé proactiva pero elegante.

[DATA_JSON ESTRUCTURA]
Al final, incluye:
DATA_JSON:{ "accion": "none" | "agendar" | "cancelar" | "reagendar", ... }`;

    const messages = [{ role: "system", content: systemPrompt }];
    // (Aquí iría la lógica del historial que ya tienes)
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    // Lógica de acciones (Agendar/Cancelar/Reagendar) - Mantenemos la tuya
    // ... (Aquí procesas el JSON y generas mensajeAccion si aplica)

    if (accionEjecutada && mensajeAccion) {
      cleanReply = `${cleanReply}\n\n${mensajeAccion}`;
    }

    // DIVIDIMOS EN MÚLTIPLES MENSAJES SI EXISTE EL SEPARADOR
    const partesMensaje = cleanReply.split('###').map(p => p.trim()).filter(p => p !== "");
    const xmlMessages = partesMensaje.map(msg => `<Message>${msg}</Message>`).join('');

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response>${xmlMessages}</Response>`);

  } catch (err) {
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento de distracción. 🌸</Message></Response>');
  }
}

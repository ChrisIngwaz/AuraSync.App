import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AIRTABLE_BASE = 'appvuzv3szWik7kn7';
const AIRTABLE_CONFIG = { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Error</Message></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');
  
  try {
    // 1. PROCESAR TEXTO/AUDIO
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const audioRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }});
      textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. BUSCAR CITA ACTIVA EN AIRTABLE (Para cancelaciones)
    const airtableRes = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas?filterByFormula={Teléfono}='${userPhone}'`, 
      AIRTABLE_CONFIG
    );
    const citaActiva = airtableRes.data.records.find(r => r.fields.Estado === 'Confirmada' || r.fields.Estado === 'Pendiente');

    // 3. CARGAR CONTEXTO DE SUPABASE
    const [histRes, servRes, eqRes, cliRes] = await Promise.all([
      supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6),
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const historial = (histRes.data || []).reverse();
    const cliente = cliRes.data;
    const nombreCliente = cliente?.nombre || "amigo/a";

    // 4. DETECTAR INTENCIÓN (Confirmación o Cancelación)
    const esConfirmacion = /(sí|si|ok|vale|dale|confirmo|perfecto|así es|listo)/i.test(textoUsuario);
    const esCancelacion = /(cancela|no puedo|no voy|posponer|quitar|borrar|ya no quiero)/i.test(textoUsuario);

    // 5. PROMPT DE SOCIO ESTRATÉGICO
    let systemPrompt = `Eres AuraSync, la coordinadora experta del centro. 
    Tu misión: Cero huecos en la agenda. Eres humana, cálida y resolutiva.
    Servicios: ${servRes.data?.map(s => s.nombre).join(', ')}.
    Equipo: ${eqRes.data?.map(e => e.nombre).join(', ')}.

    CASOS ESPECIALES:
    - CANCELACIÓN: Si el usuario quiere cancelar y tiene cita (${citaActiva ? 'Tiene cita activa' : 'No tiene'}), dile que la has liberado con una sonrisa (aunque te de pena) y ofrécele reagendar de inmediato.
    - PERSUASIÓN: Si alguien no está disponible, sugiere a otro especialista con entusiasmo.
    - RECONFIRMACIÓN: Si confirma una propuesta previa, usa DATA_JSON.`;

    if (esCancelacion && citaActiva) {
      systemPrompt += `\nACCIÓN: El usuario quiere cancelar su cita de ${citaActiva.fields.Servicio}. 
      Confirma la cancelación amablemente y genera: DATA_JSON{"accion": "cancelar", "id": "${citaActiva.id}"}DATA_JSON`;
    }

    // 6. LLAMADA A IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, ...historial, { role: "user", content: textoUsuario }],
      temperature: 0.7
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 7. PROCESAR ACCIONES EN AIRTABLE
    const jsonMatch = fullReply.match(/DATA_JSON(\{.*?\})DATA_JSON/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      
      if (data.accion === "cancelar") {
        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas`, 
          { records: [{ id: data.id, fields: { "Estado": "Cancelada" } }] }, AIRTABLE_CONFIG);
      } else if (data.servicio) {
        // Lógica de Crear Cita (Igual que antes)
        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas`, 
          { fields: { "Cliente": nombreCliente, "Servicio": data.servicio, "Fecha": data.fecha, "Especialista": data.especialista, "Teléfono": userPhone, "Estado": "Confirmada" }},
          AIRTABLE_CONFIG);
      }
    }

    // 8. LIMPIEZA Y GUARDADO
    const cleanReply = fullReply.replace(/DATA_JSON.*?DATA_JSON/g, '').trim();
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: fullReply }]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    res.status(200).send('<Response><Message>¡Hola! AuraSync por aquí. Me distraje un segundo, ¿me repites?</Message></Response>');
  }
}

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// Configuración de Conexiones
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AIRTABLE_BASE = 'appvuzv3szWik7kn7';
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN; // Asegúrate de que esta variable esté en tu Vercel/Hosting

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Error</Message></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');
  
  try {
    // 1. PROCESAR AUDIO (Deepgram)
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      try {
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }}
        );
        textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (e) { 
        console.error("Error Deepgram:", e.message);
        textoUsuario = "Envié un audio pero hubo un error al procesarlo"; 
      }
    }

    // 2. CARGAR CONTEXTO (Supabase y Airtable)
    const [histRes, servRes, eqRes, cliRes] = await Promise.all([
      supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6),
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const historial = (histRes.data || []).reverse();
    const cliente = cliRes.data;
    const nombreCliente = cliente?.nombre || "amigo/a";

    // 3. DETECTAR INTENCIONES
    const esConfirmacion = /(sí|si|ok|vale|dale|confirmo|perfecto|así es|listo)/i.test(textoUsuario);
    const esCancelacion = /(cancela|no puedo|no voy|quitar|borrar)/i.test(textoUsuario);

    // 4. PROMPT ESTRATÉGICO DE AURASYNC
    let systemPrompt = `Eres AuraSync, la coordinadora estrella. 
    Tu objetivo es gestionar citas con calidez humana. 
    Servicios: ${servRes.data?.map(s => s.nombre).join(', ')}.
    Especialistas: ${eqRes.data?.map(e => e.nombre).join(', ')}.
    
    INSTRUCCIÓN: Si el cliente confirma, genera el bloque DATA_JSON al final.
    Si el cliente pide cita, responde de forma amigable sugiriendo disponibilidad.`;

    // 5. LLAMADA A LA IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, ...historial, { role: "user", content: textoUsuario }],
      temperature: 0.7
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 6. REGISTRO EN AIRTABLE (Solución al fallo de registro)
    const jsonMatch = fullReply.match(/DATA_JSON(\{.*?\})DATA_JSON/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        // Registro exacto para tus columnas de Airtable
        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas`, 
          { 
            fields: { 
              "Cliente": nombreCliente, 
              "Servicio": data.servicio, 
              "Fecha": data.fecha || new Date().toISOString().split('T')[0], 
              "Especialista": data.especialista, 
              "Teléfono": userPhone, 
              "Estado": "Confirmada" 
            } 
          }, 
          { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }}
        );
      } catch (err) {
        console.error("Error al guardar en Airtable:", err.response?.data || err.message);
      }
    }

    // 7. LIMPIAR RESPUESTA Y GUARDAR HISTORIAL
    const cleanReply = fullReply.replace(/DATA_JSON.*?DATA_JSON/g, '').trim();
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: fullReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    res.status(200).send('<Response><Message>Hola, soy AuraSync. Tenemos mucha actividad ahora, ¿me podrías escribir de nuevo?</Message></Response>');
  }
}

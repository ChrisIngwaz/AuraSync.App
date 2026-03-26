import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AIRTABLE_BASE = 'appvuzv3szWik7kn7';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Error</Message></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');
  
  try {
    // 1. TRANSCRIPCIÓN DE AUDIO (Deepgram)
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post(
        "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, 
        { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }}
      );
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    if (!textoUsuario.trim()) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response><Message>Hola, recibí tu audio pero no logré escucharlo. ¿Podrías repetirlo o escribirme?</Message></Response>');
    }

    // 2. CONTEXTO DEL CLIENTE (Supabase)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const { data: historial } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(5);
    const mensajesPrevios = (historial || []).reverse();

    // 3. SYSTEM PROMPT DE AURASYNC (EL TUYO, SIN MEZCLAS)
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con una eficiencia impecable y un tono humano, profesional y persuasivo.

    REGLAS DE INTERACCIÓN:
    1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
    2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
    3. CLIENTES EXISTENTES: Saluda por su nombre (${cliente?.nombre || 'cliente'}) y ofrece servicios basados en su historial si está disponible.
    4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
    5. MANEJO DE CITAS: Usa un lenguaje claro para confirmar día, hora, servicio y profesional encargado.
    6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp. No uses párrafos largos.

    CONTEXTO DE NEGOCIO:
    - Los servicios incluyen cortes, color, manicura y tratamientos estéticos.
    - La política de cancelación es de mínimo 4 horas de anticipación.

    INSTRUCCIÓN TÉCNICA: Al final de tu respuesta, añade SIEMPRE este bloque JSON con los datos detectados:
    DATA_JSON:{"nombre": "...", "fecha_nacimiento": "...", "email": "...", "notas_bienestar": "..."}:DATA_JSON`;

    // 4. RESPUESTA DE OPENAI
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        ...mensajesPrevios.map(m => ({ role: m.rol, content: m.contenido })),
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.7
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 5. GUARDAR EN AIRTABLE (Detección de JSON)
    const jsonMatch = fullReply.match(/DATA_JSON:(\{.*?\系统\}):DATA_JSON/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas`, 
        { 
          fields: { 
            "Cliente": data.nombre || "Cliente WhatsApp", 
            "Teléfono": userPhone,
            "Estado": "Pendiente de Confirmar",
            "Notas": `Cumpleaños: ${data.fecha_nacimiento}`
          } 
        },
        { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }}
      );
    }

    // 6. LIMPIAR Y ENVIAR
    const cleanReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/g, '').trim();
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Hola, soy AuraSync. Tuvimos un pequeño inconveniente técnico, ¿podrías repetirme tu mensaje?</Message></Response>');
  }
}

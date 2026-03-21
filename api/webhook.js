const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const twilio = require('twilio');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Método no permitido');

  const { From, Body, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    let userText = Body || "";

    // 1. MEMORIA: Buscar o Crear cliente
    let { data: client } = await supabase.from('clients').select('*').eq('telefono', userPhone).single();
    
    if (!client) {
      const { data: newClient } = await supabase.from('clients').insert([{ telefono: userPhone }]).select().single();
      client = newClient;
    }

    // 2. INTELIGENCIA: Smart Prompt de AuraSync + Extracción de Datos
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con una eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si faltan datos (nombre, fecha_nacimiento, email), saluda con calidez y solicítalos obligatoriamente. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${client?.nombre || 'cliente'}) y ofrece servicios.
4. CIERRE DE VENTAS: Si el cliente duda, resalta beneficios (calidad, experiencia, bienestar).
5. MANEJO DE CITAS: Confirma día, hora, servicio y profesional.
6. CONCISIÓN: Respuestas breves para WhatsApp.

CONTEXTO DE NEGOCIO:
- Servicios: cortes, color, manicura y tratamientos estéticos.
- Cancelación: mínimo 4 horas de anticipación.

INSTRUCCIÓN TÉCNICA: Al final de tu respuesta, añade SIEMPRE este bloque JSON con los datos que detectes en el mensaje del usuario:
DATA_START{"nombre": "...", "fecha_nacimiento": "...", "email": "...", "notas_bienestar": "..."}DATA_END`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
    });

    let fullReply = aiResponse.choices[0].message.content;
    
    // 3. ACCIÓN: Extraer JSON y actualizar Supabase
    const dataMatch = fullReply.match(/DATA_START({.*?})DATA_END/s);
    if (dataMatch) {
      const extractedData = JSON.parse(dataMatch[1]);
      fullReply = fullReply.replace(/DATA_START.*?DATA_END/s, '').trim();

      const updates = {};
      if (extractedData.nombre && extractedData.nombre !== "...") updates.nombre = extractedData.nombre;
      if (extractedData.fecha_nacimiento && extractedData.fecha_nacimiento !== "...") updates.fecha_nacimiento = extractedData.fecha_nacimiento;
      if (extractedData.email && extractedData.email !== "...") updates.email = extractedData.email;
      if (extractedData.notas_bienestar && extractedData.notas_bienestar !== "...") updates.notas_bienestar = extractedData.notas_bienestar;

      if (Object.keys(updates).length > 0) {
        await supabase.from('clients').update(updates).eq('telefono', userPhone);
      }
    }

    // 4. ENVÍO: Respuesta limpia a WhatsApp
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: From,
      body: fullReply
    });

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Error en AuraSync:", error);
    return res.status(500).send('Error');
  }
}

const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const twilio = require('twilio');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { From, Body } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. MEMORIA: Buscar o crear cliente
    let { data: client } = await supabase.from('clients').select('*').eq('telefono', userPhone).single();
    if (!client) {
      const { data: newClient } = await supabase.from('clients').insert([{ telefono: userPhone }]).select().single();
      client = newClient;
    }

    // 2. INTELIGENCIA: Perfil Original de AuraSync
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con una eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${client?.nombre || 'cliente'}) y ofrece servicios basados en su historial si está disponible.
4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
5. MANEJO DE CITAS: Usa un lenguaje claro para confirmar día, hora, servicio y profesional encargado.
6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp. No uses párrafos largos.

CONTEXTO DE NEGOCIO:
- Los servicios incluyen cortes, color, manicura y tratamientos estéticos.
- La política de cancelación es de mínimo 4 horas de anticipación.
- Si un cliente cancela a tiempo, sé comprensiva. Si cancela tarde, menciona amablemente la política pero ofrece reprogramar para no perder la venta.

INSTRUCCIÓN TÉCNICA: Al final de tu respuesta, añade SIEMPRE este bloque JSON con los datos detectados:
DATA_JSON:{"nombre": "...", "fecha_nacimiento": "...", "email": "...", "notas_bienestar": "..."}:DATA_JSON`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: Body }
      ],
    });

    let fullReply = aiResponse.choices[0].message.content;
    
    // 3. EXTRACCIÓN Y ACTUALIZACIÓN EN SUPABASE
    const jsonRegex = /DATA_JSON:({.*?}):DATA_JSON/s;
    const match = fullReply.match(jsonRegex);

    if (match) {
      try {
        const extracted = JSON.parse(match[1]);
        fullReply = fullReply.replace(jsonRegex, '').trim();

        const updates = {};
        if (extracted.nombre && extracted.nombre !== "...") updates.nombre = extracted.nombre;
        if (extracted.fecha_nacimiento && extracted.fecha_nacimiento !== "...") updates.fecha_nacimiento = extracted.fecha_nacimiento;
        if (extracted.email && extracted.email !== "...") updates.email = extracted.email;
        if (extracted.notas_bienestar && extracted.notas_bienestar !== "...") updates.notas_bienestar = extracted.notas_bienestar;

        if (Object.keys(updates).length > 0) {
          await supabase.from('clients').update(updates).eq('telefono', userPhone);
        }
      } catch (e) {
        console.error("Error en parseo:", e);
      }
    }

    // 4. ENVÍO A WHATSAPP
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: From,
      body: fullReply
    });

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Error Crítico:", error);
    return res.status(500).send('Error');
  }
}

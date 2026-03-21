const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const twilio = require('twilio');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const { From, Body } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. OBTENER CONTEXTO (Clientes y SERVICIOS REALES)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const { data: serviciosReal } = await supabase.from('servicios').select('*');
    const { data: especialistas } = await supabase.from('especialistas').select('*');

    // 2. SMART PROMPT ORIGINAL BLINDADO CON CATÁLOGO
    const systemPrompt = `Eres la Asistente de AuraSync. Coordinadora digital, no IA. Tono humano y profesional.

CATÁLOGO DE SERVICIOS OFICIAL (Úsalos EXACTAMENTE así):
${serviciosReal?.map(s => `- ${s.nombre} (Duración: ${s.duracion}min): $${s.precio}`).join('\n')}

EQUIPO:
${especialistas?.map(e => `- ${e.nombre} (${e.especialidad})`).join('\n')}

REGLAS DE ORO:
1. Si el cliente es nuevo (${cliente?.nombre ? 'Ya lo conoces: ' + cliente.nombre : 'Es nuevo'}), pide obligatoriamente Nombre, Apellido y Fecha de Nacimiento. No agendes sin esto.
2. Solo ofrece y acepta agendar los servicios del "CATÁLOGO OFICIAL". No inventes servicios.
3. Para agendar necesitas: Servicio, Especialista, Fecha y Hora.

INSTRUCCIÓN TÉCNICA: Al final, añade SIEMPRE este JSON si detectas intención o datos:
DATA_JSON:{"nombre": "...", "servicio_id": "...", "especialista_id": "...", "fecha_cita": "YYYY-MM-DD HH:mm"}:DATA_JSON`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: Body }
      ],
    });

    let fullReply = aiResponse.choices[0].message.content;
    
    // 3. EXTRACCIÓN Y AGENDAMIENTO
    const match = fullReply.match(/DATA_JSON:({.*?}):DATA_JSON/s);

    if (match) {
      const extracted = JSON.parse(match[1]);
      fullReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/s, '').trim();

      // Guardar nombre si es nuevo
      if (extracted.nombre && extracted.nombre !== "...") {
        await supabase.from('clientes').update({ nombre: extracted.nombre }).eq('telefono', userPhone);
      }

      // INSERTAR CITA SI ESTÁ COMPLETA
      if (extracted.servicio_id !== "..." && extracted.fecha_cita !== "...") {
        // Buscamos el ID real del servicio basado en el nombre que detectó la IA
        const servicioSolicitado = serviciosReal.find(s => s.id === extracted.servicio_id);
        
        if (servicioSolicitado) {
          await supabase.from('citas').insert([{
            cliente_id: cliente?.id,
            servicio_id: servicioSolicitado.id,
            especialista_id: extracted.especialista_id !== "..." ? extracted.especialista_id : null,
            fecha_hora: extracted.fecha_cita,
            estado: 'programada'
          }]);
        }
      }
    }

    // 4. ENVÍO
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: From,
      body: fullReply
    });

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Error AuraSync:", error);
    return res.status(200).send('OK');
  }
}

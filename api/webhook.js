import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AIRTABLE_BASE = 'appvuzv3szWik7kn7';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  try {
    // 1. PROCESAR AUDIO O TEXTO
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }});
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. OBTENER CONTEXTO REAL (Supabase)
    const { data: clienteExistente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: esp } = await supabase.from('especialistas').select('nombre');
    const { data: serv } = await supabase.from('servicios').select('nombre');
    
    const primerNombre = clienteExistente?.nombre ? clienteExistente.nombre.split(' ')[0] : 'cliente';
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const listaServ = serv?.map(s => s.nombre).join(', ') || "cortes y estética";

    // 3. TU SYSTEM PROMPT ORIGINAL (SIN CAMBIOS)
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con una eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${primerNombre}) y ofrece servicios basados en su historial si está disponible.
4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
5. MANEJO DE CITAS: Usa un lenguaje claro para confirmar día, hora, servicio y profesional encargado. Especialistas disponibles: ${listaEsp}. Servicios: ${listaServ}.
6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp. No uses párrafos largos.

CONTEXTO DE NEGOCIO:
- Los servicios incluyen cortes, color, manicura y tratamientos estéticos.
- La política de cancelación es de mínimo 4 horas de anticipación.
- Si un cliente cancela a tiempo, sé comprensiva. Si cancela tarde, menciona amablemente la política pero ofrece reprogramar para no perder la venta.

INSTRUCCIÓN TÉCNICA: Al final de tu respuesta, añade SIEMPRE este bloque JSON con los datos detectados:
DATA_JSON:{"nombre": "...", "apellido": "...", "fecha_nacimiento": "...", "email": "...", "servicio": "...", "especialista": "...", "notas_bienestar": "..."}:DATA_JSON`;

    // 4. RESPUESTA IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoUsuario }],
      temperature: 0.4
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 5. REGISTRO EN SUPABASE (Con columna 'apellido' ya creada)
    const jsonMatch = fullReply.match(/DATA_JSON:(\{.*?\系统\}):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const d = JSON.parse(jsonMatch[1]);
        if (d.nombre && d.nombre !== "..." && d.nombre.trim() !== "") {
          const payload = {
            telefono: userPhone,
            nombre: d.nombre.trim(),
            apellido: (d.apellido && d.apellido !== "...") ? d.apellido.trim() : null,
            fecha_nacimiento: (d.fecha_nacimiento && d.fecha_nacimiento !== "...") ? d.fecha_nacimiento : null,
            email: (d.email && d.email !== "...") ? d.email : null,
            notas_bienestar: (d.notas_bienestar && d.notas_bienestar !== "...") ? d.notas_bienestar : null
          };
          await supabase.from('clientes').upsert(payload, { onConflict: 'telefono' });
        }

        // Registro en Airtable
        if (d.servicio && d.servicio !== "...") {
          await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas`, 
            { fields: { "Cliente": `${d.nombre} ${d.apellido !== "..." ? d.apellido : ""}`.trim(), "Servicio": d.servicio, "Especialista": d.especialista, "Teléfono": userPhone, "Estado": "Confirmada" }},
            { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }}
          ).catch(e => console.error("Airtable Error"));
        }
      } catch (e) { console.error("Parse Error"); }
    }

    // 6. RESPONDER Y MEMORIA
    const cleanReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/gs, '').trim();
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Hola, soy AuraSync. Tuvimos un detalle técnico, ¿podrías repetirme eso?</Message></Response>');
  }
}

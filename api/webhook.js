import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  try {
    // 1. TRANSCRIPCIÓN (SI ES AUDIO)
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }});
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. DETECCIÓN PREVENTIVA DE DATOS (Registro Directo)
    // Si el mensaje contiene un nombre obvio, lo guardamos antes de que la IA responda
    const palabras = textoUsuario.split(' ');
    if (palabras.length >= 2 && !clienteExistente) {
      // Intento de guardado rápido si detectamos formato "Nombre Apellido"
      await supabase.from('clientes').upsert({
        telefono: userPhone,
        nombre: palabras[0],
        apellido: palabras[1] || null
      }, { onConflict: 'telefono' });
    }

    // 3. CARGAR CONTEXTO ACTUALIZADO
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: esp } = await supabase.from('especialistas').select('nombre');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio');
    
    const primerNombre = cliente?.nombre ? cliente.nombre.split(' ')[0] : 'cliente';
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = serv?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "nuestros servicios";

    // 4. TU SYSTEM PROMPT (INTOCABLE)
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con una eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${primerNombre}) y ofrece servicios basados en su historial si está disponible.
4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
5. MANEJO DE CITAS: Especialistas disponibles: ${listaEsp}. Servicios: ${catalogo}.
6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp.

INSTRUCCIÓN TÉCNICA: Al final añade SIEMPRE: DATA_JSON:{"nombre": "...", "apellido": "...", "fecha_nacimiento": "..."}:DATA_JSON`;

    // 5. RESPUESTA IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoUsuario }],
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 6. PROCESAMIENTO FINAL DEL JSON
    const jsonMatch = fullReply.match(/DATA_JSON:(\{.*?\系统\}):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const d = JSON.parse(jsonMatch[1]);
        if (d.nombre && d.nombre !== "...") {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: d.nombre.trim(),
            apellido: d.apellido !== "..." ? d.apellido.trim() : null,
            fecha_nacimiento: d.fecha_nacimiento !== "..." ? d.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
        }
      } catch (e) {}
    }

    const cleanReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/gs, '').trim();
    
    // Guardar en conversaciones para la memoria
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    res.status(200).send('<Response><Message>AuraSync: Hubo un inconveniente técnico, ¿me repites?</Message></Response>');
  }
}

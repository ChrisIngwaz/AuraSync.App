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
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 ${userPhone}`);

  try {
    // 1. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { 
            headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Error con audio. Escribime por favor.</Message></Response>');
      }
    }

    // 2. CARGAR CLIENTE Y VALIDAR SI ES NUEVO
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente?.nombre;
    const primerNombre = cliente?.nombre?.split(' ')[0] || null;

    // 3. RECUPERAR HISTORIAL SÓLO SI EL CLIENTE EXISTE (ÉLITE)
    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(6);
      
      if (mensajes) {
        historialFiltrado = mensajes.reverse();
      }
    } else {
      console.log('⚡ Cliente nuevo detectado. Forzando historial vacío para evitar redundancia.');
    }

    // 4. DATOS DE NEGOCIO
    const { data: especialistas } = await supabase.from('especialistas').select('nombre');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";
    
    // 5. SYSTEM PROMPT - AURASYNC (ELITE, DIAGNÓSTICO Y VENTA)
    const ahora = new Date();
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Guayaquil'
    }).format(ahora);
    const anioActual = ahora.getFullYear();

    const systemPrompt = `Tu nombre es Aura, asesora de imagen de élite en AuraSync. Tu comunicación es sofisticada, ejecutiva y altamente consultiva. No eres una secretaria, eres una experta que guía al cliente.

[CONTEXTO TEMPORAL CRÍTICO]
- Hoy es ${hoyEcuador}. Año: ${anioActual}.
- REGLA: Calcula "mañana" o cualquier día basándote estrictamente en que hoy es ${hoyEcuador}.

[PROTOCOLO DE ASESORÍA Y VENTA]
1. BIENVENIDA: Si el cliente es nuevo, solicita Nombre, Apellido y Fecha de Nacimiento con elegancia minimalista.
2. EL DIAGNÓSTICO (OBLIGATORIO): Si piden un servicio (ej. corte), antes de confirmar, haz una pregunta experta: "¿Hace cuánto no cortas tus puntas?" o "¿Cómo sientes la hidratación y vitalidad de tu cabello actualmente?".
3. LA RECOMENDACIÓN (UPSELLING): Basado en su respuesta, sugiere un plus. "Para que su corte luzca impecable y recuperemos la vitalidad de las puntas, le sugiero sumar nuestra Hidratación Profunda".
4. SELECCIÓN DE ESPECIALISTA: NUNCA asignes a alguien sin preguntar. Presenta opciones resaltando sus fortalezas:
   * "Para este trabajo, ¿prefiere la precisión técnica de Carlos o prefiere a Anita, que es nuestra experta en recuperación capilar?".
   * Especialistas disponibles: ${listaEsp}.

[REGLAS DE ORO]
- NUNCA digas "como usted prefiera" o "no tengo preferencias". Guía siempre con una sugerencia profesional.
- Usa un lenguaje de negocios de alta gama (vitalidad, técnica, precisión, agenda premium).
- Si el usuario ya dio un dato, no lo repitas. Avanza hacia el cierre.

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente el bloque JSON. Si aún no eligen especialista o fecha, usa "...".
DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "..."
}`;

    // 6. CONSTRUIR MENSAJES PARA AI
    const messages = [{ role: "system", content: systemPrompt }];
    historialFiltrado.forEach(msg => {
      // Ajuste de mapeo de nombres de columna si es necesario
      messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido });
    });
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 7. PROCESAR JSON Y AGENDAR
    let datosExtraidos = {};
    let citaCreada = false;
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || "",
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          cliente = { nombre: datosExtraidos.nombre }; // Actualización local
        }

        const tieneFecha = datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
        
        if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre)) {
          citaCreada = await crearCitaAirtable({
            telefono: userPhone,
            nombre: cliente?.nombre || datosExtraidos.nombre,
            apellido: cliente?.apellido || datosExtraidos.apellido || "",
            fecha: datosExtraidos.cita_fecha,
            hora: datosExtraidos.cita_hora,
            servicio: datosExtraidos.cita_servicio !== "..." ? datosExtraidos.cita_servicio : "Servicio",
            especialista: datosExtraidos.cita_especialista !== "..." ? datosExtraidos.cita_especialista : "Asignar",
            precio: 0, 
            duracion: 60
          });
        }
      } catch (e) { console.error('Error JSON:', e.message); }
    }

    // 8. FINALIZAR RESPUESTA
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) cleanReply += `\n\n✅ Cita registrada.`;

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Error técnico.</Message></Response>');
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": datos.fecha,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada"
        }
      }]
    };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }});
    return true;
  } catch (error) { return false; }
}

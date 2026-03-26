import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuración Airtable
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_TABLE_NAME = 'Citas'; // Ajusta si tu tabla tiene otro nombre

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  try {
    // 1. TRANSCRIPCIÓN (SI ES AUDIO)
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post(
        "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, 
        { 
          headers: { 
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 
            'Content-Type': 'application/json' 
          }
        }
      );
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. CARGAR CLIENTE EXISTENTE Y DETERMINAR SI ES PRIMERA VEZ
    const { data: clienteExistente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esPrimeraVez = !clienteExistente;

    // 3. DETECCIÓN PREVENTIVA DE DATOS
    const palabras = textoUsuario.split(' ');
    if (palabras.length >= 2 && esPrimeraVez) {
      await supabase.from('clientes').upsert({
        telefono: userPhone,
        nombre: palabras[0],
        apellido: palabras[1] || null
      }, { onConflict: 'telefono' });
    }

    // 4. RECARGAR CONTEXTO ACTUALIZADO
    const { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .single();
      
    const { data: esp } = await supabase.from('especialistas').select('nombre');
    
    // Consulta corregida: usando 'duracion' (no 'duracion_minutos')
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const primerNombre = cliente?.nombre ? cliente.nombre.split(' ')[0] : 'cliente';
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = serv?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "nuestros servicios";
    
    // Mapa de servicios usando 'duracion' (columna correcta de Supabase)
    const serviciosMap = {};
    serv?.forEach(s => {
      serviciosMap[s.nombre.toLowerCase()] = {
        precio: s.precio,
        duracion: s.duracion || 60 // Usa 60 min como default si viene null
      };
    });

    // 5. SYSTEM PROMPT
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${primerNombre}) y ofrece servicios basados en su historial si está disponible.
4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
5. MANEJO DE CITAS: Especialistas disponibles: ${listaEsp}. Servicios: ${catalogo}.
6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp.

FORMATO DE FECHAS OBLIGATORIO:
Cuando el usuario confirme una fecha y hora para su cita, debes extraer y formatear los datos EXACTAMENTE así:
- cita_fecha: Formato YYYY-MM-DD (ejemplo: 2026-03-30)
- cita_hora: Formato HH:MM en 24 horas (ejemplo: 14:30 para las 2:30 PM)

Ejemplos:
- "mañana a las 3 de la tarde" → cita_fecha: "2026-03-28", cita_hora: "15:00"
- "el lunes a las 10" → cita_fecha: "2026-03-30", cita_hora: "10:00"

INSTRUCCIÓN TÉCNICA FINAL: Al final de tu respuesta, agrega SIEMPRE este bloque JSON exacto (rellena con los datos reales si los tienes, usa "..." o null si faltan datos):

DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "...",
  "cita_hora": "...",
  "cita_servicio": "...",
  "cita_especialista": "..."
}:DATA_JSON`;

    // 6. RESPUESTA IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt }, 
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.3
    }, { 
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    let fullReply = aiRes.data.choices[0].message.content;

    // 7. PROCESAMIENTO DEL JSON
    const jsonMatch = fullReply.match(/DATA_JSON:\s*(\{[\s\S]*?\})\s*:DATA_JSON/);
    let datosExtraidos = {};
    
    if (jsonMatch) {
      try {
        const jsonLimpio = jsonMatch[1].replace(/\n/g, '').replace(/\s+/g, ' ').trim();
        datosExtraidos = JSON.parse(jsonLimpio);
        
        // Actualizar Supabase si hay datos personales nuevos
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && datosExtraidos.nombre !== "") {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: (datosExtraidos.apellido && datosExtraidos.apellido !== "..." && datosExtraidos.apellido !== "") 
              ? datosExtraidos.apellido.trim() 
              : cliente?.apellido,
            fecha_nacimiento: (datosExtraidos.fecha_nacimiento && datosExtraidos.fecha_nacimiento !== "..." && datosExtraidos.fecha_nacimiento !== "")
              ? datosExtraidos.fecha_nacimiento 
              : cliente?.fecha_nacimiento
          }, { onConflict: 'telefono' });
        }

        // 8. CREAR CITA EN AIRTABLE
        if (datosExtraidos.cita_fecha && 
            datosExtraidos.cita_fecha !== "..." && 
            datosExtraidos.cita_hora && 
            datosExtraidos.cita_hora !== "...") {
          
          // Buscar precio y duración usando la columna correcta 'duracion'
          const servicioKey = datosExtraidos.cita_servicio?.toLowerCase();
          const infoServicio = serviciosMap[servicioKey] || { precio: 0, duracion: 60 };
          
          await crearCitaAirtable({
            telefono: userPhone,
            nombre: datosExtraidos.nombre || cliente?.nombre,
            apellido: datosExtraidos.apellido || cliente?.apellido,
            esPrimeraVez: esPrimeraVez,
            fecha: datosExtraidos.cita_fecha,
            hora: datosExtraidos.cita_hora,
            servicio: datosExtraidos.cita_servicio || 'No especificado',
            especialista: datosExtraidos.cita_especialista || 'No asignado',
            precio: infoServicio.precio,
            duracion: infoServicio.duracion, // Ahora usa la columna correcta
            notas: `Cita agendada vía WhatsApp. Mensaje original: "${textoUsuario.substring(0, 200)}"`
          });
          
          console.log(`✅ Cita creada para ${userPhone}: ${datosExtraidos.cita_fecha} ${datosExtraidos.cita_hora} - Servicio: ${datosExtraidos.cita_servicio} (${infoServicio.duracion}min, $${infoServicio.precio})`);
        }
      } catch (e) {
        console.error('❌ Error procesando JSON o guardando datos:', e);
        console.error('JSON recibido:', jsonMatch ? jsonMatch[1] : 'No match');
      }
    }

    // Limpiar respuesta para el usuario
    const cleanReply = fullReply.replace(/DATA_JSON:[\s\S]*?:DATA_JSON/, '').trim();
    
    // 9. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error general en handler:', err);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>AuraSync: Hubo un inconveniente técnico, ¿me repites?</Message></Response>');
  }
}

// Función auxiliar para crear registros en Airtable
async function crearCitaAirtable(datos) {
  try {
    const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.trim();
    
    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`,
      {
        records: [
          {
            fields: {
              "Cliente": nombreCompleto || "Sin nombre",
              "Servicio": datos.servicio,
              "Fecha": datos.fecha,
              "Especialista": datos.especialista,
              "Teléfono": datos.telefono,
              "Estado": "Confirmada",
              "Notas de la cita": datos.notas,
              "Email de cliente": "",
              "¿Es primera vez?": datos.esPrimeraVez ? "Sí" : "No",
              "Cliente VIP": "No",
              "Duración estimada (minutos)": datos.duracion, // Usa el valor de la columna 'duracion' de Supabase
              "Importe estimado": datos.precio,
              "Observaciones de confirmación": `Agendado el ${new Date().toLocaleDateString('es-ES')} a las ${new Date().toLocaleTimeString('es-ES')}`
            }
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Cita creada en Airtable ID:', response.data.records[0].id);
    return response.data;
    
  } catch (error) {
    console.error('❌ Error creando cita en Airtable:', error.response?.data || error.message);
    if (error.response?.data?.error) {
      console.error('Detalle error Airtable:', JSON.stringify(error.response.data.error, null, 2));
    }
  }
}

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuración Airtable con validación
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Citas';

// Validación crítica al inicio
if (!AIRTABLE_BASE_ID || !AIRTABLE_API_KEY) {
  console.error('❌ ERROR CRÍTICO: Faltan variables de entorno de Airtable');
}

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
    
    // Usando 'duracion' (nombre correcto de tu columna en Supabase)
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const primerNombre = cliente?.nombre ? cliente.nombre.split(' ')[0] : 'cliente';
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = serv?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "nuestros servicios";
    
    // Mapa de servicios usando 'duracion'
    const serviciosMap = {};
    serv?.forEach(s => {
      serviciosMap[s.nombre.toLowerCase()] = {
        precio: s.precio,
        duracion: s.duracion || 60
      };
    });

    // 5. SYSTEM PROMPT COMPLETO CON INSTRUCCIONES DE FECHA
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${primerNombre}) y ofrece servicios basados en su historial si está disponible.
4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
5. MANEJO DE CITAS: Especialistas disponibles: ${listaEsp}. Servicios: ${catalogo}.
6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp.

FORMATO DE FECHAS OBLIGATORIO (CRÍTICO PARA EL SISTEMA):
Cuando el usuario confirme una fecha y hora para su cita, debes extraer y formatear los datos EXACTAMENTE así:
- cita_fecha: Formato YYYY-MM-DD (ejemplo: 2026-03-30 para el 30 de marzo de 2026)
- cita_hora: Formato HH:MM en 24 horas (ejemplo: 14:30 para las 2:30 PM, 09:00 para las 9:00 AM)

Ejemplos de conversión:
- "mañana a las 3 de la tarde" → cita_fecha: "2026-03-28", cita_hora: "15:00" (asumiendo que hoy es 27/03/2026)
- "el lunes a las 10 de la mañana" → cita_fecha: "2026-03-30", cita_hora: "10:00"
- "viernes 4 de abril a la 1" → cita_fecha: "2026-04-04", cita_hora: "13:00"

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

        // 8. CREAR CITA EN AIRTABLE (CON VALIDACIÓN DE CREDENCIALES)
        if (datosExtraidos.cita_fecha && 
            datosExtraidos.cita_fecha !== "..." && 
            datosExtraidos.cita_hora && 
            datosExtraidos.cita_hora !== "...") {
          
          // Verificar credenciales antes de llamar
          if (!AIRTABLE_BASE_ID || !AIRTABLE_API_KEY) {
            console.error('❌ No se puede crear cita: Faltan credenciales de Airtable');
            console.error('Base ID:', AIRTABLE_BASE_ID ? 'OK' : 'FALTANTE');
            console.error('API Key:', AIRTABLE_API_KEY ? 'OK' : 'FALTANTE');
          } else {
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
              duracion: infoServicio.duracion,
              notas: `Cita agendada vía WhatsApp. Mensaje original: "${textoUsuario.substring(0, 200)}"`
            });
          }
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

// Función auxiliar CORREGIDA para evitar NOT_FOUND
async function crearCitaAirtable(datos) {
  try {
    const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.trim();
    
    // Asegurar tipos de datos correctos para Airtable
    const duracionNum = parseInt(datos.duracion) || 60;
    const precioNum = parseFloat(datos.precio) || 0;
    
    // FIX CRÍTICO: Codificar nombre de tabla por si tiene espacios
    const tableNameEncoded = encodeURIComponent(AIRTABLE_TABLE_NAME);
    
    // Construir URL correctamente
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableNameEncoded}`;
    
    console.log('🔗 URL Airtable:', url);
    console.log('📋 Verificación - Base ID existe:', !!AIRTABLE_BASE_ID);
    console.log('📋 Verificación - Tabla:', AIRTABLE_TABLE_NAME);

    const fields = {
      "Cliente": nombreCompleto || "Sin nombre",
      "Servicio": datos.servicio || "No especificado",
      "Fecha": datos.fecha,
      "Especialista": datos.especialista || "No asignado",
      "Teléfono": datos.telefono,
      "Estado": "Confirmada",
      "Notas de la cita": datos.notas || "",
      "Email de cliente": "",
      "¿Es primera vez?": datos.esPrimeraVez ? "Sí" : "No",
      "Cliente VIP": "No",
      "Duración estimada (minutos)": duracionNum,
      "Importe estimado": precioNum,
      "Observaciones de confirmación": `Agendado el ${new Date().toLocaleDateString('es-ES')}`
    };

    console.log('📤 Enviando a Airtable:', JSON.stringify(fields, null, 2));

    const response = await axios.post(
      url,
      {
        records: [{ fields }]
      },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ ÉXITO - Cita creada en Airtable ID:', response.data.records[0].id);
    return response.data;
    
  } catch (error) {
    console.error('❌ ERROR AIRTABLE DETALLADO:');
    console.error('Status:', error.response?.status);
    console.error('Status Text:', error.response?.statusText);
    
    if (error.response?.data?.error) {
      console.error('Error completo:', JSON.stringify(error.response.data.error, null, 2));
      
      if (error.response?.status === 404) {
        console.error('💡 SOLUCIÓN: El error 404 (NOT_FOUND) significa:');
        console.error('   1. Revisa en Vercel que AIRTABLE_BASE_ID empiece con "app..."');
        console.error('   2. Revisa que AIRTABLE_TABLE_NAME sea exactamente el nombre de tu tabla');
        console.error('   3. Si tu tabla se llama "Citas", verifica que no sea "citas" (minúsculas)');
        console.error('   4. Ve a Airtable → API documentation para copiar la URL exacta');
      }
    } else {
      console.error('Error message:', error.message);
    }
    
    // No lanzamos el error para no romper la conversación con el usuario
    return null;
  }
}

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// ==================== CONFIGURACIÓN ====================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

// Validación de configuración crítica
const validarConfig = () => {
  const faltantes = [];
  if (!CONFIG.AIRTABLE_BASE_ID) faltantes.push('AIRTABLE_BASE_ID');
  if (!CONFIG.AIRTABLE_TOKEN) faltantes.push('AIRTABLE_TOKEN');
  if (!CONFIG.DEEPGRAM_API_KEY) faltantes.push('DEEPGRAM_API_KEY');
  if (!CONFIG.OPENAI_API_KEY) faltantes.push('OPENAI_API_KEY');
  
  if (faltantes.length > 0) {
    console.error('❌ Variables de entorno faltantes:', faltantes.join(', '));
    return false;
  }
  return true;
};

// ==================== HANDLER PRINCIPAL ====================
export default async function handler(req, res) {
  // Validar método
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { Body, From, MediaUrl0 } = req.body;
  
  // Validar número de teléfono
  if (!From) {
    return res.status(400).json({ error: 'Missing From parameter' });
  }

  const userPhone = From.replace('whatsapp:', '').trim();
  console.log(`\n📱 Nueva interacción: ${userPhone}`);
  console.log(`⏰ Fecha: ${new Date().toISOString()}`);

  try {
    // 1. PROCESAR ENTRADA (Audio o Texto)
    let textoUsuario = Body || "";
    let esAudio = false;
    
    if (MediaUrl0) {
      esAudio = true;
      console.log('🎙️ Modo: AUDIO');
      
      if (!CONFIG.DEEPGRAM_API_KEY) {
        return responderTwilio(res, "Estoy teniendo problemas con el audio. ¿Podrías escribirme por favor?");
      }

      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true&punctuate=true", 
          { url: MediaUrl0 }, 
          { 
            headers: { 
              'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 
              'Content-Type': 'application/json' 
            },
            timeout: 15000
          }
        );
        
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        
        if (!textoUsuario) {
          return responderTwilio(res, "No pude escuchar bien el audio. ¿Podrías repetirlo más claro o escribirme?");
        }
        
        console.log('📝 Transcripción:', textoUsuario);
      } catch (error) {
        console.error('❌ Error Deepgram:', error.message);
        return responderTwilio(res, "Tuve problemas procesando el audio. Intenta escribiendo tu mensaje.");
      }
    } else {
      console.log('💬 Modo: TEXTO -', textoUsuario);
    }

    // 2. CARGAR CONTEXTO DEL CLIENTE Y HISTORIAL
    let { data: cliente, error: errorCliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    if (errorCliente) {
      console.error('Error cargando cliente:', errorCliente);
    }

    // Cargar últimas 5 interacciones para contexto
    const { data: historial, error: errorHistorial } = await supabase
      .from('conversaciones')
      .select('rol, contenido, created_at')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(5);

    // Determinar estado
    const esNuevo = !cliente?.nombre;
    const primerNombre = cliente?.nombre?.split(' ')[0] || null;
    const nombreCompleto = cliente?.nombre && cliente?.apellido 
      ? `${cliente.nombre} ${cliente.apellido}` 
      : null;

    console.log(`👤 Cliente: ${esNuevo ? 'NUEVO' : primerNombre}`);

    // 3. CARGAR CATÁLOGO
    const { data: especialistas, error: errorEsp } = await supabase
      .from('especialistas')
      .select('nombre');
      
    const { data: servicios, error: errorServ } = await supabase
      .from('servicios')
      .select('nombre, precio, duracion');

    if (errorEsp || errorServ) {
      console.error('Error cargando catálogo:', errorEsp || errorServ);
    }

    const listaEspecialistas = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogoServicios = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios disponibles";
    
    // Mapa de servicios con sinónimos para búsqueda inteligente
    const mapaServicios = {};
    servicios?.forEach(s => {
      const key = s.nombre.toLowerCase();
      mapaServicios[key] = s;
      
      // Sinónimos comunes
      if (key.includes('corte') || key.includes('cabello')) {
        mapaServicios['cortarme el pelo'] = s;
        mapaServicios['cortar el pelo'] = s;
        mapaServicios['cortarme el cabello'] = s;
        mapaServicios['corte de pelo'] = s;
      }
      if (key.includes('manicura') || key.includes('uñas')) {
        mapaServicios['manicure'] = s;
        mapaServicios['uñas'] = s;
        mapaServicios['pintar uñas'] = s;
      }
      if (key.includes('hidratación') || key.includes('tratamiento')) {
        mapaServicios['tratamiento'] = s;
        mapaServicios['hidratarme el pelo'] = s;
      }
    });

    // 4. CONSTRUIR SYSTEM PROMPT OPTIMIZADO
    const systemPrompt = `Eres Aura, la coordinadora profesional de AuraSync Salon. Tu objetivo es agendar citas de forma natural y eficiente.

ESTADO DEL CLIENTE:
${esNuevo 
  ? `🆕 CLIENTE NUEVO (Tel: ${userPhone}). DEBES obtener: Nombre, Apellido y Fecha de Nacimiento antes de agendar. Pídelos de forma natural.` 
  : `👤 CLIENTE REGISTRADO: ${primerNombre}. Trátalo solo por "${primerNombre}" (nunca por nombre completo). Saluda brevemente y pregunta directamente qué necesita.`
}

CATÁLOGO ACTUAL:
Servicios: ${catalogoServicios}
Especialistas: ${listaEspecialistas}

PROTOCOLO DE INTERACCIÓN:

1. SI EL CLIENTE EMPIEZA CON "HOLA" O SALUDO:
   - ${esNuevo ? 'Bienvenida cálida + solicitud de datos personales.' : `Saluda: "Hola ${primerNombre}, ¿qué servicio necesitas hoy?"`}

2. SI EL CLIENTE PIDE CITA DIRECTAMENTE (ej: "quiero corte mañana a las 3"):
   - ${esNuevo ? 'Primero: "Perfecto, para agendarte necesito tu nombre completo, apellido y fecha de nacimiento". Luego: "Listo, ahora dime..." y continúas con la cita.' : 'Confirma el servicio, fecha y hora directamente.'}
   - Extrae automáticamente: servicio, fecha (convierte "mañana" a YYYY-MM-DD), hora (convierte "3 de la tarde" a 15:00).

3. CONVERSIÓN AUTOMÁTICA DE FECHAS (tú haces la conversión, no pidas formato al usuario):
   - "mañana" → fecha actual + 1 día, formato YYYY-MM-DD
   - "pasado mañana" → fecha actual + 2 días
   - "el lunes" → próximo lunes en formato YYYY-MM-DD
   - "3 de la tarde" → "15:00"
   - "media día" → "12:00"
   - "27 de mayo del 76" → "1976-05-27"

4. REGLAS IMPORTANTES:
   - Sé breve y natural (estilo WhatsApp).
   - Nunca repitas información que el cliente ya dio en mensajes anteriores (revisa el historial).
   - Si detectas el servicio por sinónimos ("cortarme el pelo"), úsalo correctamente.
   - No uses lenguaje técnico (JSON, YYYY-MM-DD) con el cliente.

FORMATO JSON OBLIGATORIO (solo tú ves esto, al final de tu respuesta):
DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD si detectaste fecha",
  "cita_hora": "HH:MM si detectaste hora",
  "cita_servicio": "Nombre exacto del servicio del catálogo",
  "cita_especialista": "Nombre específico o 'Cualquiera disponible'"
}:DATA_JSON`;

    // 5. PREPARAR MENSAJES CON HISTORIAL (MEMORIA)
    const messages = [{ role: "system", content: systemPrompt }];
    
    if (historial && historial.length > 0) {
      historial.reverse().forEach(msg => {
        messages.push({ role: msg.rol, content: msg.contenido });
      });
    }
    
    messages.push({ role: "user", content: textoUsuario });

    // 6. LLAMADA A OPENAI
    console.log('🤖 Enviando a OpenAI...');
    
    const aiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions', 
      {
        model: "gpt-4o",
        messages: messages,
        temperature: 0.4,
        max_tokens: 500
      }, 
      { 
        headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
        timeout: 15000
      }
    );

    let fullReply = aiRes.data.choices[0].message.content;
    console.log('💬 Respuesta IA:', fullReply.substring(0, 100) + '...');

    // 7. PROCESAR JSON Y GUARDAR DATOS
    const jsonMatch = fullReply.match(/DATA_JSON:\s*(\{[\s\S]*?\})\s*:DATA_JSON/);
    let citaCreada = false;
    let datosExtraidos = {};
    let datosPersonalesGuardados = false;
    
    if (jsonMatch) {
      try {
        let jsonStr = jsonMatch[1]
          .replace(/\\n/g, ' ')
          .replace(/\n/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/,\s*}/g, '}')
          .trim();
          
        datosExtraidos = JSON.parse(jsonStr);
        console.log('📊 Datos extraídos:', JSON.stringify(datosExtraidos, null, 2));

        // GUARDAR DATOS PERSONALES
        const tieneDatosValidos = datosExtraidos.nombre && 
                                  datosExtraidos.apellido && 
                                  datosExtraidos.nombre !== "..." && 
                                  datosExtraidos.apellido !== "..." &&
                                  datosExtraidos.nombre.length > 1 &&
                                  datosExtraidos.apellido.length > 1;

        if (esNuevo && tieneDatosValidos) {
          console.log('💾 Guardando nuevo cliente...');
          
          const { error: errorUpsert } = await supabase
            .from('clientes')
            .upsert({
              telefono: userPhone,
              nombre: datosExtraidos.nombre.trim(),
              apellido: datosExtraidos.apellido.trim(),
              fecha_nacimiento: (datosExtraidos.fecha_nacimiento && datosExtraidos.fecha_nacimiento !== "..." && datosExtraidos.fecha_nacimiento.match(/^\d{4}-\d{2}-\d{2}$/)) 
                ? datosExtraidos.fecha_nacimiento 
                : null,
              created_at: new Date().toISOString()
            }, { onConflict: 'telefono' });
            
          if (errorUpsert) {
            console.error('❌ Error guardando cliente:', errorUpsert);
            datosPersonalesGuardados = false;
          } else {
            console.log('✅ Cliente guardado en Supabase');
            datosPersonalesGuardados = true;
            // Recargar cliente para tener los datos actualizados
            cliente = { 
              nombre: datosExtraidos.nombre.trim(), 
              apellido: datosExtraidos.apellido.trim() 
            };
          }
        } else if (!esNuevo) {
          datosPersonalesGuardados = true;
        }

        // VALIDACIÓN ESTRICTA ANTES DE CREAR CITA EN AIRTABLE
        // 1. Verificar que tenemos fecha válida (formato real YYYY-MM-DD, no placeholder)
        const fechaValida = datosExtraidos.cita_fecha && 
                           datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
        
        // 2. Verificar hora válida (HH:MM)
        const horaValida = datosExtraidos.cita_hora && 
                          datosExtraidos.cita_hora.match(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/);
        
        // 3. Verificar que el usuario realmente quiso agendar (intención)
        const textoLower = textoUsuario.toLowerCase();
        const intencionAgendar = /(quiero|agendar|cita|reservar|pedir|sacar|hacer|mañana|hoy|pasado|lunes|martes|miércoles|jueves|viernes|sábado|domingo|\d{1,2}:\d{2})/.test(textoLower);
        
        // 4. Verificar servicio válido
        const servicioValido = datosExtraidos.cita_servicio && 
                              datosExtraidos.cita_servicio !== "..." &&
                              datosExtraidos.cita_servicio.length > 2;

        console.log('🔍 Validaciones cita:', {
          fechaValida: !!fechaValida,
          horaValida: !!horaValida,
          intencionAgendar: intencionAgendar,
          servicioValido: servicioValido,
          datosPersonalesGuardados: datosPersonalesGuardados
        });

        if (fechaValida && horaValida && servicioValido && datosPersonalesGuardados) {
          if (!intencionAgendar) {
            console.log('⚠️ Datos de cita presentes pero NO detecté intención de agendar. Omitiendo creación en Airtable.');
          } else {
            // Buscar información del servicio
            const servicioKey = datosExtraidos.cita_servicio.toLowerCase();
            const infoServicio = mapaServicios[servicioKey] || { 
              nombre: datosExtraidos.cita_servicio, 
              precio: 0, 
              duracion: 60 
            };

            const nombreParaCita = datosExtraidos.nombre || cliente?.nombre;
            const apellidoParaCita = datosExtraidos.apellido || cliente?.apellido;

            if (!nombreParaCita || !apellidoParaCita) {
              console.error('❌ Falta nombre o apellido para crear cita');
            } else if (!validarConfig()) {
              console.error('❌ Faltan credenciales de Airtable');
            } else {
              console.log('📅 Creando cita en Airtable...');
              
              citaCreada = await crearCitaAirtable({
                telefono: userPhone,
                nombre: nombreParaCita,
                apellido: apellidoParaCita,
                esPrimeraVez: esNuevo,
                fecha: datosExtraidos.cita_fecha,
                hora: datosExtraidos.cita_hora,
                servicio: infoServicio.nombre,
                especialista: datosExtraidos.cita_especialista || "Cualquiera disponible",
                precio: infoServicio.precio,
                duracion: infoServicio.duracion
              });
            }
          }
        } else {
          console.log('ℹ️ No se creó cita: faltan datos válidos o no hay intención clara');
        }
      } catch (error) {
        console.error('❌ Error procesando JSON:', error.message);
        console.error('JSON problemático:', jsonMatch[1]);
      }
    } else {
      console.log('⚠️ No se encontró bloque DATA_JSON');
    }

    // 8. PREPARAR RESPUESTA FINAL
    let cleanReply = fullReply.replace(/DATA_JSON:[\s\S]*?:DATA_JSON/, '').trim();
    
    // Agregar confirmación de cita si se creó exitosamente
    if (citaCreada && !cleanReply.includes('✓') && !cleanReply.includes('confirmada')) {
      cleanReply += `\n\n✅ ¡Perfecto! Tu cita ha sido registrada. Te esperamos.`;
    }

    // 9. GUARDAR CONVERSACIÓN EN HISTORIAL
    const { error: errorConv } = await supabase
      .from('conversaciones')
      .insert([
        { telefono: userPhone, rol: 'user', contenido: textoUsuario, tipo: esAudio ? 'audio' : 'texto' }, 
        { telefono: userPhone, rol: 'assistant', contenido: cleanReply, tipo: 'texto' }
      ]);

    if (errorConv) {
      console.error('❌ Error guardando conversación:', errorConv);
    }

    return responderTwilio(res, cleanReply);

  } catch (error) {
    console.error('❌ Error general:', error.message);
    console.error('Stack:', error.stack);
    return responderTwilio(res, "Ups, tuve un problema técnico. ¿Intentamos de nuevo en un momento?");
  }
}

// ==================== FUNCIONES AUXILIARES ====================

// Helper para responder a Twilio con XML válido
function responderTwilio(res, mensaje) {
  // Escapar caracteres XML especiales
  const mensajeEscapado = mensaje
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
    
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${mensajeEscapado}</Message></Response>`);
}

// Crear cita en Airtable - con validaciones y logs detallados
async function crearCitaAirtable(datos) {
  try {
    const nombreCompleto = `${datos.nombre} ${datos.apellido}`.trim();
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    
    // Validar que la fecha sea real antes de enviar
    if (!datos.fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
      console.error('❌ Fecha inválida:', datos.fecha);
      return false;
    }

    const payload = {
      records: [{
        fields: {
          "Cliente": nombreCompleto,
          "Servicio": datos.servicio,
          "Fecha": datos.fecha,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Notas de la cita": `Agendado por WhatsApp Bot`,
          "Email de cliente": "",
          "Cliente VIP": "No",
          "Duración estimada (minutos)": parseInt(datos.duracion) || 60,
          "Importe estimado": parseFloat(datos.precio) || 0,
          "Observaciones de confirmación": `Creada: ${new Date().toLocaleString('es-ES')}`
        }
      }]
    };

    console.log('🔗 URL Airtable:', url);
    console.log('📋 Payload completo:', JSON.stringify(payload, null, 2));

    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log('✅ Cita creada. ID:', response.data.records[0].id);
    return true;
    
  } catch (error) {
    console.error('❌ Error Airtable detallado:');
    console.error('Status:', error.response?.status);
    console.error('Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Message:', error.message);
    
    if (error.response?.status === 422) {
      console.error('💡 Error 422: Datos inválidos. Revisa que:');
      console.error('   - La fecha tenga formato YYYY-MM-DD (ej: 2026-03-27)');
      console.error('   - El campo Fecha en Airtable sea tipo "Date" o "Single line text"');
      console.error('   - No haya campos requeridos vacíos en Airtable');
    }
    
    return false;
  }
}

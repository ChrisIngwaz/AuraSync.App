import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import twilio from 'twilio';
import syncAirtable from './sync-airtable.js';
import dailyReport from './daily-report.js';
import reminders from './reminders.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORRECCIÓN: Crear cliente SIN cache de schema para evitar PGRST204
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  {
    db: {
      schema: 'public'
    },
    global: {
      headers: {
        'Accept-Profile': 'public',
        'Content-Profile': 'public'
      }
    }
  }
);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER
};

const { MessagingResponse } = twilio.twiml;

// ============ RUTAS DE LA API ============

app.get(['/', '/webhook', '/api/webhook'], (req, res) => {
  res.status(200).send('🚀 AuraSync Online - Webhook listo para recibir mensajes de WhatsApp.');
});

app.post(['/', '/webhook', '/api/webhook'], async (req, res) => {
  const { Body, From, MediaUrl0 } = req.body;
  
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`📥 [${new Date().toISOString()}] NUEVA SOLICITUD`);
  console.log(`📱 De: ${From || 'Desconocido'}`);
  console.log(`💬 Body: ${Body || '(vacío)'}`);
  console.log(`🎙️ Media: ${MediaUrl0 ? 'SÍ' : 'NO'}`);
  console.log(`═══════════════════════════════════════════════════\n`);
  
  const userPhone = From ? From.replace('whatsapp:', '').replace('+', '').trim() : '';
  
  if (!userPhone) {
    console.log('❌ CRÍTICO: No se detectó número de teléfono');
    return res.status(200).send('<Response></Response>');
  }

  let respuestaParaUsuario = "";
  let textoUsuario = Body || "";
  let accionData = null;

  try {
    // ========== PROCESAMIENTO DE AUDIO ==========
    if (MediaUrl0) {
      console.log('🎙️ Procesando nota de voz con Deepgram...');
      try {
        const dr = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true", 
          { url: MediaUrl0 }, 
          { 
            headers: { 
              'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 
              'Content-Type': 'application/json' 
            },
            timeout: 10000
          }
        );
        textoUsuario = dr.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log(`✅ Transcripción: "${textoUsuario}"`);
      } catch (audioError) {
        console.error('❌ Error Deepgram:', audioError.message);
        textoUsuario = "[Error procesando audio]";
        respuestaParaUsuario = "Disculpa, no pude escuchar tu nota de voz claramente. ¿Podrías escribirme o enviarla de nuevo? 🎙️";
      }
    }

    // ========== OBTENER CONTEXTO ==========
    console.log('🔍 Obteniendo contexto de base de datos...');
    
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('*')
      .or(`telefono.eq.${userPhone},telefono.eq.+${userPhone}`)
      .maybeSingle();
    
    if (clienteError) console.error('⚠️ Error consultando cliente:', clienteError.message);
    console.log(cliente ? `👤 Cliente encontrado: ${cliente.nombre} ${cliente.apellido}` : '👤 Cliente NUEVO');

    const { data: esp, error: espError } = await supabase.from('especialistas').select('id, nombre, rol, expertise');
    if (espError) console.error('⚠️ Error especialistas:', espError.message);
    
    const { data: serv, error: servError } = await supabase.from('servicios').select('id, nombre, precio, duracion');
    if (servError) console.error('⚠️ Error servicios:', servError.message);

    // Timezone Ecuador forzado
    const hoy = new Date().toLocaleDateString('es-EC', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
      timeZone: 'America/Guayaquil' 
    });

    const { data: mensajes } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(6);
    const historial = mensajes ? mensajes.reverse() : [];

    // ========== SYSTEM PROMPT PREMIUM ==========
    const systemPrompt = `Eres Aura, la Coordinadora Ejecutiva de AuraSync. No eres un bot, eres una profesional sofisticada, cálida y extremadamente eficiente. Tu misión es que el cliente sienta que está tratando con la mejor asistente personal del mundo.

[TU ESENCIA]
- Lenguaje impecable: español elegante, profesional y cercano
- NUNCA digas "soy una IA", "como asistente virtual", o frases robóticas
- Usa emojis con moderación y naturalidad ✨💫🌸
- Reconoces al cliente por nombre si ya existe en el sistema
- Eficiencia total: cierras citas en mínimos mensajes, sin dar vueltas

[CONTEXTO DEL SISTEMA]
- Especialistas disponibles: ${esp?.map(e => `${e.nombre} (${e.rol}: ${e.expertise})`).join(', ') || 'Consultar disponibilidad'}
- Servicios: ${serv?.map(s => `${s.nombre} $${s.precio}, ${s.duracion}min`).join(', ') || 'Consultar catálogo'}
- Horario atención: 9:00 a 18:00 (hora Ecuador)
- Fecha hoy: ${hoy}
- Cliente actual: ${cliente ? `${cliente.nombre} ${cliente.apellido} (REGISTRADO - VIP)` : 'NUEVO - requiere registro'}

[REGLAS DE ORO - ZERO ERRORES]
1. Si cliente REGISTRADO: NO pidas nombre, apellido, ciudad ni fecha de nacimiento
2. Si cliente NUEVO: pide con elegancia los 4 datos antes de agendar
3. Si cliente dice "cita mañana 3pm con Elena para manicura": CONFIRMA directamente, no preguntes de nuevo
4. Anticipación: ofrece horarios alternativos si el solicitado no está disponible
5. Coordinación perfecta: verifica que especialista + horario + servicio = disponible real

[FORMATO OBLIGATORIO]
AL FINAL de cada respuesta, en línea separada, incluye SIEMPRE:
DATA_JSON:{"accion":"none"|"agendar"|"reagendar"|"cancelar","nombre":"${cliente?.nombre || '...'}","apellido":"${cliente?.apellido || '...'}","ciudad":"${cliente?.ciudad || '...'}","fecha_nacimiento":"${cliente?.fecha_nacimiento || '...'}","cita_fecha":"YYYY-MM-DD","cita_hora":"HH:MM","cita_servicio":"...","cita_especialista":"..."}`;

    // ========== LLAMADA A OPENAI ==========
    console.log('🤖 Consultando a OpenAI GPT-4o...');
    
    try {
      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-4o", 
        messages: [
          { role: "system", content: systemPrompt }, 
          ...historial.map(m => ({ role: m.rol, content: m.contenido })), 
          { role: "user", content: textoUsuario }
        ], 
        temperature: 0.25,
        max_tokens: 400
      }, { 
        headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
        timeout: 12000
      });
      
      const fullReply = aiRes.data.choices[0].message.content;
      console.log('📝 RESPUESTA OPENAI:', fullReply.substring(0, 300) + (fullReply.length > 300 ? '...' : ''));
      
      // Extraer JSON y mensaje limpio
      const { mensajeLimpio, datosAccion } = extraerJSON(fullReply);
      respuestaParaUsuario = mensajeLimpio;
      accionData = datosAccion;
      
    } catch (aiError) {
      console.error('❌ Error OpenAI:', aiError.message);
      // Mensaje humano, sin exponer error técnico
      respuestaParaUsuario = cliente 
        ? `Disculpa ${cliente.nombre}, tuve un pequeño lapsus. ¿Me repetirías qué servicio necesitas y para cuándo? 💫`
        : `Hola, bienvenido a AuraSync. Para atenderte con nuestro servicio VIP, ¿me regalas tu nombre completo, ciudad y fecha de nacimiento? ✨`;
    }

    // ========== PROCESAR ACCIONES ==========
    if (accionData && accionData.accion && accionData.accion !== 'none') {
      console.log(`🎯 Procesando acción: ${accionData.accion}`);
      
      let clienteActivo = cliente;

      // ----- REGISTRO DE NUEVO CLIENTE -----
      if (!cliente && esRegistroCompleto(accionData)) {
        console.log('📝 Registrando nuevo cliente VIP...');
        
        const { data: nuevoCliente, error: registroError } = await supabase
          .from('clientes')
          .insert({
            telefono: userPhone,
            nombre: accionData.nombre,
            apellido: accionData.apellido,
            ciudad: accionData.ciudad,
            fecha_nacimiento: accionData.fecha_nacimiento,
            created_at: new Date().toISOString()
          })
          .select()
          .single();
        
        if (registroError) {
          console.error('❌ ERROR REGISTRO CLIENTE:', registroError);
          respuestaParaUsuario = `Tuve un inconveniente registrando tus datos. ¿Lo intentamos de nuevo? Solo dime tu nombre, ciudad y fecha de nacimiento una vez más. 🙏`;
          accionData = null;
        } else {
          console.log('✅ Cliente registrado:', nuevoCliente.id);
          clienteActivo = nuevoCliente;
          
          // Reprocesar la acción de cita ahora que tenemos cliente
          if (accionData.accion === 'agendar') {
            const resultadoCita = await procesarAccionCita(accionData, nuevoCliente, userPhone, esp, serv);
            if (resultadoCita.exito) {
              respuestaParaUsuario = `¡Perfecto ${nuevoCliente.nombre}! Ya estás en nuestro sistema VIP y tu cita está confirmada. 🌟\n\n${resultadoCita.mensaje}`;
            } else {
              respuestaParaUsuario = `Bienvenido ${nuevoCliente.nombre}, ya tienes tu perfil activo. ${resultadoCita.mensaje}`;
            }
          } else {
            respuestaParaUsuario = `¡Bienvenido ${nuevoCliente.nombre}! Tu perfil VIP está activo. ¿En qué puedo ayudarte hoy? ✨`;
          }
          accionData = null; // Ya procesamos todo
        }
      } else if (!cliente && accionData.accion === 'agendar') {
        console.log('⚠️ Intento de agendar sin registro completo');
        respuestaParaUsuario = `💎 Para darte el servicio VIP que mereces, necesito completar tu registro primero. ¿Me compartes tu nombre completo, ciudad y fecha de nacimiento (YYYY-MM-DD)?`;
        accionData = null;
      }

      // ----- ACCIONES DE CITA (para clientes ya registrados) -----
      if (clienteActivo && clienteActivo.id && accionData && accionData.accion !== 'none') {
        
        if (!esp || !Array.isArray(esp) || esp.length === 0 || !serv || !Array.isArray(serv) || serv.length === 0) {
          console.error('❌ ERROR: No se cargaron especialistas o servicios');
          respuestaParaUsuario = "Dame un momento, estoy revisando la agenda. ¿Me das un segundo? 🌸";
        } else {
          console.log('🔍 DEBUG - Procesando cita:', {
            accion: accionData.accion,
            clienteId: clienteActivo.id,
            numEsp: esp.length,
            numServ: serv.length,
            fecha: accionData.cita_fecha,
            hora: accionData.cita_hora,
            servicio: accionData.cita_servicio,
            especialista: accionData.cita_especialista
          });

          const resultado = await procesarAccionCita(accionData, clienteActivo, userPhone, esp, serv);
          
          if (resultado.exito && resultado.mensaje) {
            respuestaParaUsuario = resultado.mensaje;
            console.log('✅ Cita procesada exitosamente');
          } else if (!resultado.exito && resultado.mensaje) {
            respuestaParaUsuario = resultado.mensaje;
            console.log('❌ Error procesando cita:', resultado.mensaje);
          }
        }
      }
    } else {
      console.log('ℹ️ Sin acción de cita detectada');
    }

    // ========== GUARDAR CONVERSACIÓN ==========
    console.log('💾 Guardando conversación...');
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: respuestaParaUsuario, created_at: new Date().toISOString() }
    ]);

    // ========== RESPONDER ==========
    const twiml = new MessagingResponse();
    twiml.message(respuestaParaUsuario);
    res.setHeader('Content-Type', 'text/xml');
    
    console.log(`✅ Respuesta enviada`);
    console.log(`═══════════════════════════════════════════════════\n`);
    
    return res.status(200).send(twiml.toString());

  } catch (error) { 
    console.error('❌❌❌ ERROR CRÍTICO EN WEBHOOK:', error);
    console.error(error.stack);
    
    const twiml = new MessagingResponse();
    twiml.message("Aura tuvo un momento de distracción ejecutiva. ¿Podemos intentarlo de nuevo? 🌸");
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  }
});

// ============ FUNCIÓN AUXILIAR: EXTRAER JSON ============

function extraerJSON(fullReply) {
  // Buscar JSON al final del mensaje
  const jsonMatch = fullReply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})\s*$/i);
  
  if (jsonMatch) {
    try {
      const datos = JSON.parse(jsonMatch[1]);
      const mensaje = fullReply.replace(/DATA_JSON[\s\S]*/i, '').trim();
      return { mensajeLimpio: mensaje, datosAccion: datos };
    } catch (e) {
      console.log('⚠️ JSON encontrado pero inválido:', e.message);
    }
  }
  
  // Intentar otros patrones si el primero falla
  const patrones = [
    /DATA_JSON\s*:\s*(\{[\s\S]*?\})\s*\n/i,
    /DATA_JSON\s*:\s*(\{[\s\S]*?\})/i,
    /DATA_JSON\s+(\{[\s\S]*?\})/i
  ];
  
  for (const pattern of patrones) {
    const match = fullReply.match(pattern);
    if (match) {
      try {
        const datos = JSON.parse(match[1]);
        const mensaje = fullReply.replace(/DATA_JSON[\s\S]*/i, '').trim();
        return { mensajeLimpio: mensaje, datosAccion: datos };
      } catch (e) {
        continue;
      }
    }
  }
  
  return { mensajeLimpio: fullReply, datosAccion: null };
}

// ============ FUNCIÓN AUXILIAR: VERIFICAR REGISTRO COMPLETO ============

function esRegistroCompleto(accionData) {
  return accionData && 
         accionData.nombre && accionData.nombre !== "..." && 
         accionData.apellido && accionData.apellido !== "..." &&
         accionData.ciudad && accionData.ciudad !== "..." &&
         accionData.fecha_nacimiento && /^\d{4}-\d{2}-\d{2}$/.test(accionData.fecha_nacimiento);
}

// ============ FUNCIÓN CENTRAL DE ACCIONES ============

async function procesarAccionCita(datos, cliente, telefono, especialistasLista, serviciosLista) {
  console.log(`\n🎯 PROCESANDO ACCIÓN: ${datos.accion?.toUpperCase() || 'DESCONOCIDA'}`);
  console.log(`👤 Cliente: ${cliente?.nombre} ${cliente?.apellido} (ID: ${cliente?.id})`);
  
  const resultado = { exito: false, mensaje: '', error: null };

  try {
    if (!datos || typeof datos !== 'object') {
      return { ...resultado, mensaje: 'No entendí bien qué necesitas. ¿Me lo explicas de nuevo? 🌸' };
    }

    if (!datos.accion) {
      return { ...resultado, mensaje: '¿Qué te gustaría hacer? Agendar, reprogramar o cancelar una cita? 💫' };
    }

    if (!especialistasLista || !Array.isArray(especialistasLista) || especialistasLista.length === 0) {
      console.error('❌ ERROR: especialistasLista vacía');
      return { ...resultado, mensaje: 'Estoy revisando la disponibilidad de nuestros especialistas. Un momento por favor. ✨' };
    }

    if (!serviciosLista || !Array.isArray(serviciosLista) || serviciosLista.length === 0) {
      console.error('❌ ERROR: serviciosLista vacía');
      return { ...resultado, mensaje: 'Estoy consultando nuestros servicios. Dame un segundo. 🌸' };
    }

    // ----- AGENDAR -----
    if (datos.accion === 'agendar') {
      console.log('📋 Datos agendar:', {
        fecha: datos.cita_fecha,
        hora: datos.cita_hora,
        servicio: datos.cita_servicio,
        especialista: datos.cita_especialista
      });

      if (!datos.cita_fecha || datos.cita_fecha === "..." || 
          !datos.cita_hora || datos.cita_hora === "...") {
        return { ...resultado, mensaje: 'Para agendarte necesito saber qué día y a qué hora te gustaría. ¿Me dices? 📅' };
      }

      // Buscar servicio
      let servicio = null;
      if (datos.cita_servicio && datos.cita_servicio !== "...") {
        const busquedaServicio = datos.cita_servicio.toLowerCase().trim();
        servicio = serviciosLista.find(s => 
          s.nombre && (
            s.nombre.toLowerCase().includes(busquedaServicio) ||
            busquedaServicio.includes(s.nombre.toLowerCase())
          )
        );
      }

      // Buscar especialista
      let especialista = null;
      if (datos.cita_especialista && datos.cita_especialista !== "...") {
        const busquedaEsp = datos.cita_especialista.toLowerCase().trim();
        especialista = especialistasLista.find(e => 
          e.nombre && (
            e.nombre.toLowerCase().includes(busquedaEsp) ||
            busquedaEsp.includes(e.nombre.toLowerCase())
          )
        );
      }

      console.log('🔍 Búsqueda resultados:', {
        servicioBuscado: datos.cita_servicio,
        servicioEncontrado: servicio?.nombre || 'NO',
        especialistaBuscado: datos.cita_especialista,
        especialistaEncontrado: especialista?.nombre || 'NO'
      });

      if (!servicio) {
        const disponibles = serviciosLista.map(s => s.nombre).join(', ');
        return { ...resultado, mensaje: `Hmm, no tengo registrado "${datos.cita_servicio}" en este momento. Te cuento que manejamos: ${disponibles}. ¿Cuál te interesa? 💫` };
      }

      if (!especialista) {
        const disponibles = especialistasLista.map(e => e.nombre).join(', ');
        if (!datos.cita_especialista || datos.cita_especialista === '...') {
          return { ...resultado, mensaje: `¿Con quién te gustaría atenderte? Tenemos disponibles: ${disponibles} 👩‍💼` };
        }
        return { ...resultado, mensaje: `No encontré a "${datos.cita_especialista}" en nuestro equipo. Nuestros especialistas son: ${disponibles}. ¿Con quién prefieres? ✨` };
      }

      // Verificar disponibilidad
      console.log('🔍 Verificando disponibilidad...');
      const disponible = await verificarDisponibilidadRobusta(
        datos.cita_fecha, 
        datos.cita_hora, 
        especialista.id, 
        servicio.duracion
      );

      if (!disponible.ok) {
        return { ...resultado, mensaje: disponible.mensaje };
      }

      // CREAR CITA EN SUPABASE
      console.log('💾 Creando cita en Supabase...');
      const fechaHoraISO = `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`;
      
      const { data: citaCreada, error: errorCita } = await supabase
        .from('citas')
        .insert({
          cliente_id: cliente.id,
          servicio_id: servicio.id,
          especialista_id: especialista.id,
          fecha_hora: fechaHoraISO,
          estado: 'Confirmada',
          nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido}`.trim(),
          servicio_aux: servicio.nombre,
          duracion_aux: servicio.duracion,
          precio: servicio.precio,
          telefono_aux: telefono,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (errorCita) {
        console.error('❌ ERROR SUPABASE:', errorCita);
        if (errorCita.message && errorCita.message.includes('Could not find')) {
          console.log('⚠️ Intentando insert sin campo problemático...');
          const { data: citaCreadaRetry, error: errorRetry } = await supabase
            .from('citas')
            .insert({
              cliente_id: cliente.id,
              servicio_id: servicio.id,
              especialista_id: especialista.id,
              fecha_hora: fechaHoraISO,
              estado: 'Confirmada',
              nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido}`.trim(),
              servicio_aux: servicio.nombre,
              duracion_aux: servicio.duracion,
              telefono_aux: telefono,
              created_at: new Date().toISOString()
            })
            .select()
            .single();
          
          if (errorRetry) {
            throw new Error(`Error al guardar cita (retry): ${errorRetry.message}`);
          }
          
          if (!citaCreadaRetry || !citaCreadaRetry.id) {
            throw new Error('Supabase no retornó ID de cita (retry)');
          }
          
          console.log('✅ Cita creada en Supabase (sin precio):', citaCreadaRetry.id);
          
          return await sincronizarAirtableYResponder(
            citaCreadaRetry, cliente, telefono, servicio, especialista, datos, resultado
          );
        }
        
        throw new Error(`Error al guardar cita: ${errorCita.message}`);
      }

      if (!citaCreada || !citaCreada.id) {
        throw new Error('Supabase no retornó ID de cita');
      }

      console.log('✅ Cita creada en Supabase:', citaCreada.id);

      return await sincronizarAirtableYResponder(
        citaCreada, cliente, telefono, servicio, especialista, datos, resultado
      );
    }

    // ----- REAGENDAR -----
    else if (datos.accion === 'reagendar') {
      if (!datos.cita_fecha || !datos.cita_hora) {
        return { ...resultado, mensaje: 'Para reprogramar necesito la nueva fecha y hora. ¿Cuándo te funciona mejor? 📅' };
      }

      const { data: citaActual } = await supabase
        .from('citas')
        .select('id, servicio_id, especialista_id, fecha_hora, servicio_aux, duracion_aux')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', new Date().toISOString())
        .order('fecha_hora', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!citaActual) {
        return { ...resultado, mensaje: 'No encontré citas próximas para reprogramar. ¿Quieres agendar una nueva? 💫' };
      }

      const disponible = await verificarDisponibilidadRobusta(
        datos.cita_fecha,
        datos.cita_hora,
        citaActual.especialista_id,
        citaActual.duracion_aux || 60
      );

      if (!disponible.ok) {
        return { ...resultado, mensaje: disponible.mensaje };
      }

      const nuevaFechaHora = `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`;
      const { error: updateError } = await supabase
        .from('citas')
        .update({ 
          fecha_hora: nuevaFechaHora,
          updated_at: new Date().toISOString()
        })
        .eq('id', citaActual.id);

      if (updateError) throw new Error(`Error actualizando: ${updateError.message}`);

      // Actualizar Airtable
      try {
        const formula = encodeURIComponent(`{ID_Supabase} = '${citaActual.id}'`);
        const searchRes = await axios.get(
          `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`,
          { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } }
        );

        if (searchRes.data.records.length > 0) {
          await axios.patch(
            `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
            {
              records: [{
                id: searchRes.data.records[0].id,
                fields: { 
                  "Fecha": datos.cita_fecha, 
                  "Hora": datos.cita_hora,
                  "Estado": "Confirmada",
                  "Última actualización": new Date().toISOString()
                }
              }]
            },
            { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } }
          );
        }
      } catch (airtableError) {
        console.error('⚠️ Error actualizando Airtable:', airtableError.message);
      }

      return {
        exito: true,
        mensaje: `🔄 *Cita Reprogramada*\n\n"${citaActual.servicio_aux}" ahora:\n📅 ${formatearFecha(datos.cita_fecha)} a las ${datos.cita_hora}\n\n¡Nos vemos! ✨`
      };
    }

    // ----- CANCELAR -----
    else if (datos.accion === 'cancelar') {
      const { data: citaActual } = await supabase
        .from('citas')
        .select('id, servicio_aux, fecha_hora')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', new Date().toISOString())
        .order('fecha_hora', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!citaActual) {
        return { ...resultado, mensaje: 'No encontré citas próximas para cancelar. ¿Necesitas agendar una? 💫' };
      }

      const { error: cancelError } = await supabase
        .from('citas')
        .update({ 
          estado: 'Cancelada',
          updated_at: new Date().toISOString()
        })
        .eq('id', citaActual.id);

      if (cancelError) throw new Error(`Error cancelando: ${cancelError.message}`);

      // Cancelar en Airtable
      try {
        const formula = encodeURIComponent(`{ID_Supabase} = '${citaActual.id}'`);
        const searchRes = await axios.get(
          `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`,
          { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } }
        );

        if (searchRes.data.records.length > 0) {
          await axios.patch(
            `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
            {
              records: [{
                id: searchRes.data.records[0].id,
                fields: { 
                  "Estado": "Cancelada",
                  "Última actualización": new Date().toISOString()
                }
              }]
            },
            { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } }
          );
        }
      } catch (airtableError) {
        console.error('⚠️ Error cancelando en Airtable:', airtableError.message);
      }

      return {
        exito: true,
        mensaje: `🚫 *Cita Cancelada*\n\n"${citaActual.servicio_aux}" para el ${formatearFecha(citaActual.fecha_hora.split('T')[0])} cancelada.\n\n¿Agendamos otra? 💫`
      };
    }

    else {
      return { ...resultado, mensaje: '¿Qué te gustaría hacer? Puedes agendar, reprogramar o cancelar tu cita. ✨' };
    }

  } catch (error) {
    console.error('❌ ERROR EN procesarAccionCita:', error);
    return {
      exito: false,
      mensaje: 'Tuve un pequeño contratiempo. ¿Lo intentamos de nuevo? 🌸',
      error: error.message
    };
  }
}

// ============ FUNCIÓN AUXILIAR PARA SINCRONIZAR AIRTABLE ============

async function sincronizarAirtableYResponder(citaCreada, cliente, telefono, servicio, especialista, datos, resultado) {
  console.log('☁️ Sincronizando con Airtable...');
  let airtableOk = false;
  
  try {
    const airtableRes = await axios.post(
      `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`,
      {
        records: [{
          fields: {
            "ID_Supabase": citaCreada.id,
            "Cliente": `${cliente.nombre} ${cliente.apellido}`.trim(),
            "Servicio": servicio.nombre,
            "Fecha": datos.cita_fecha,
            "Hora": datos.cita_hora,
            "Especialista": especialista.nombre,
            "Teléfono": telefono,
            "Estado": "Confirmada",
            "Importe estimado": servicio.precio,
            "Duración estimada (minutos)": servicio.duracion,
            "Fecha creación": new Date().toISOString()
          }
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    if (airtableRes.data.records && airtableRes.data.records.length > 0) {
      console.log('✅ Sincronizado con Airtable:', airtableRes.data.records[0]?.id);
      airtableOk = true;
    }
  } catch (airtableError) {
    console.error('⚠️ ERROR AIRTABLE (cita SÍ está en Supabase):', airtableError.message);
  }

  return {
    exito: true,
    mensaje: `✅ *Cita Confirmada*\n\n📅 ${formatearFecha(datos.cita_fecha)} a las ${datos.cita_hora}\n💇‍♀️ ${servicio.nombre}\n👤 Con ${especialista.nombre}\n⏱️ ${servicio.duracion} minutos\n💰 $${servicio.precio}${!airtableOk ? '\n\n⚠️ (Sincronización pendiente)' : ''}\n\nTe espero con ganas de consentirte. ✨`,
    citaId: citaCreada.id
  };
}

// ============ UTILIDADES ============

function timeToMinutes(hora) {
  if (!hora || typeof hora !== 'string') return null;
  const [h, m] = hora.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

async function verificarDisponibilidadRobusta(fecha, hora, especialistaId, duracionMinutos) {
  console.log(`   📅 Fecha: ${fecha}, ⏰ Hora: ${hora}, 👤 EspID: ${especialistaId}, ⏱️ Dur: ${duracionMinutos}`);
  
  if (!fecha || !hora || !especialistaId) {
    return { ok: false, mensaje: 'Necesito revisar algunos datos. ¿Me confirmas la fecha, hora y especialista? 🌸' };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    console.error('   ❌ Formato fecha inválido:', fecha);
    return { ok: false, mensaje: 'La fecha no tiene el formato correcto. ¿Me la das así: AAAA-MM-DD? 📅' };
  }

  const inicioNueva = timeToMinutes(hora);
  if (inicioNueva === null) {
    return { ok: false, mensaje: 'La hora no tiene el formato correcto. ¿Me la das así: HH:MM? ⏰' };
  }
  
  const duracion = parseInt(duracionMinutos) || 60;
  const finNueva = inicioNueva + duracion;
  const horaMaximaInicio = 1080 - duracion;
  
  if (inicioNueva < 540) {
    return { ok: false, mensaje: 'Nuestro horario comienza a las 9:00. ¿Te funciona a esa hora? ☀️' };
  }
  
  if (inicioNueva > horaMaximaInicio) {
    const horaSugerida = Math.floor(horaMaximaInicio / 60);
    const minSugerida = horaMaximaInicio % 60;
    const horaStr = `${horaSugerida.toString().padStart(2, '0')}:${minSugerida.toString().padStart(2, '0')}`;
    return { ok: false, mensaje: `Para este servicio de ${duracion} minutos, el último horario disponible es ${horaStr}. ¿Te funciona? ✨` };
  }

  const { data: citasExistentes, error } = await supabase
    .from('citas')
    .select('fecha_hora, duracion_aux, servicio_aux')
    .eq('especialista_id', especialistaId)
    .gte('fecha_hora', `${fecha}T00:00:00`)
    .lte('fecha_hora', `${fecha}T23:59:59`)
    .in('estado', ['Confirmada', 'En proceso']);

  if (error) {
    console.error('   ❌ Error consultando citas:', error);
    return { ok: false, mensaje: 'Estoy revisando la agenda. Un momento por favor. 🌸' };
  }

  for (const cita of citasExistentes || []) {
    const horaExistente = cita.fecha_hora.includes('T') 
      ? cita.fecha_hora.split('T')[1].substring(0, 5) 
      : cita.fecha_hora.substring(11, 16);
    
    const inicioExistente = timeToMinutes(horaExistente);
    const finExistente = inicioExistente + (cita.duracion_aux || 60);
    
    if (inicioNueva < finExistente && finNueva > inicioExistente) {
      return { 
        ok: false, 
        mensaje: `Ese horario se cruza con "${cita.servicio_aux}" a las ${horaExistente}. ¿Te funciona otra hora o prefieres otro especialista? 💫` 
      };
    }
  }

  console.log('   ✅ Disponibilidad confirmada');
  return { ok: true };
}

function formatearFecha(fechaISO) {
  if (!fechaISO) return '';
  const [anio, mes, dia] = fechaISO.split('-');
  const fecha = new Date(anio, mes - 1, dia);
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Guayaquil'
  });
}

// ============ OTRAS RUTAS ============

app.post('/api/sync-airtable', syncAirtable);
app.get('/api/daily-report', dailyReport);
app.get('/api/reminders', reminders);

// ============ EXPORTACIÓN PARA VERCEL ============
export default async function handler(req, res) {
  return app(req, res);
}

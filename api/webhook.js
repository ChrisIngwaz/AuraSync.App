// ============ WEBHOOK PRINCIPAL ============

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : '';

  if (!userPhone) {
    return res.status(200).send('<Response></Response>');
  }

  try {
    // 1. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es",
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
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Disculpa, no pude escuchar bien. ¿Me escribes? 🎙️</Message></Response>');
      }
    }

    // 2. CARGAR DATOS
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    // 3. CALCULAR FECHAS
    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);
    
    const textoLower = textoUsuario.toLowerCase();
    const mencionaManana = textoLower.includes('mañana') || textoLower.includes('manana');
    const fechaReferencia = mencionaManana ? fechaManana : fechaHoy;

    // 4. CONSULTAR AGENDA
    const citasOcupadas = await obtenerCitasOcupadas(fechaReferencia);

    // 🔥 Cargar historial de conversación (últimos 6 mensajes)
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(6);

    const historialFormateado = historial?.reverse().map(h => 
      `${h.rol === 'user' ? 'Cliente' : 'Aura'}: ${h.contenido}`
    ).join('\n') || '';

    // 5. SYSTEM PROMPT CORREGIDO
    const systemPrompt = `Eres Aura, coordinadora de AuraSync. CONCRETA RÁPIDO. Máximo 2 intercambios para agendar.

[REGLA CRÍTICA]
Si en el historial el cliente YA dijo: servicio + fecha + hora → CONFIRMA ESPECIALISTA Y AGENDA. No preguntes de nuevo.

[ESTILO]
- Directa: "Perfecto, confirmo tu cita:"
- NUNCA repreguntes lo que ya sabes
- Guía tú, no dejes que el cliente adivine

[DATOS]
- Hoy: ${formatearFecha(fechaHoy)}
- Mañana: ${formatearFecha(fechaManana)}
- Ocupadas: ${citasOcupadas.length > 0 ? citasOcupadas.map(c => `${c.hora} ${c.especialista}`).join(', ') : 'Ninguna'}

[ESPECIALISTAS]
${especialistas?.map(e => `- ${e.nombre} (ID: ${e.id}): ${e.expertise}`).join('\n')}

[SERVICIOS]
${servicios?.map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion}min`).join('\n')}

[HISTORIAL RECIENTE]
${historialFormateado}

[INSTRUCCIÓN]
Analiza el historial. Si el mensaje actual es una elección de especialista (ej: "Carlos", "el primero", "Ricardo") y en mensajes anteriores ya dijo servicio/hora/fecha → ASUME esos datos y agenda inmediatamente.

[JSON]
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "nombre exacto del servicio",
  "cita_especialista": "nombre exacto del especialista",
  "especialista_id": "ID del especialista",
  "servicio_id": "ID del servicio"
}`;

    // 6. LLAMADA A OPENAI
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.2,
      max_tokens: 500
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let reply = aiRes.data.choices[0].message.content;
    console.log('📝 Respuesta OpenAI:', reply.substring(0, 200));

    // 7. PROCESAR RESPUESTA
    const jsonMatch = reply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})/);
    let data = {};
    let accionEjecutada = false;
    let mensajeFinal = reply.split('DATA_JSON')[0].trim();

    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
        
        // Registrar cliente nuevo
        if (data.nombre && !cliente?.nombre) {
          const { data: nuevoCliente } = await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: data.nombre,
            apellido: data.apellido || "",
            created_at: new Date().toISOString()
          }, { onConflict: 'telefono' }).select().single();
          
          cliente = nuevoCliente;
        }

        // Determinar fecha final
        let fechaFinal = data.cita_fecha;
        if (!fechaFinal || fechaFinal === "..." || !fechaFinal.match(/^\d{4}-\d{2}-\d{2}$/)) {
          fechaFinal = mencionaManana ? fechaManana : fechaHoy;
        }
        
        if (fechaFinal < fechaHoy) {
          fechaFinal = fechaManana;
        }

        // Buscar IDs reales
        const servicio = servicios?.find(s => 
          s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())
        );
        
        const especialista = especialistas?.find(e => 
          e.nombre.toLowerCase().includes((data.cita_especialista || '').toLowerCase())
        );

        // ============ AGENDAR ============
        if (data.accion === 'agendar' && data.cita_hora && data.cita_especialista && servicio && especialista) {
          
          const disponible = await verificarDisponibilidad(
            fechaFinal,
            data.cita_hora,
            data.cita_especialista,
            servicio.duracion,
            citasOcupadas
          );

          if (!disponible.ok) {
            mensajeFinal = disponible.mensaje;
          } else {
            // Crear en Supabase con IDs correctos
            const { data: citaSupabase, error: errorSupabase } = await supabase
              .from('citas')
              .insert({
                cliente_id: cliente?.id,
                servicio_id: servicio.id,
                especialista_id: especialista.id,
                fecha_hora: `${fechaFinal}T${data.cita_hora}:00-05:00`,
                estado: 'Confirmada',
                created_at: new Date().toISOString()
              })
              .select()
              .single();

            if (errorSupabase) {
              console.error('Error Supabase:', errorSupabase);
              throw errorSupabase;
            }

            // Crear en Airtable
            await crearCitaAirtable({
              telefono: userPhone,
              nombre: cliente?.nombre || data.nombre,
              apellido: cliente?.apellido || data.apellido || "",
              fecha: fechaFinal,
              hora: data.cita_hora,
              servicio: servicio.nombre,
              especialista: especialista.nombre,
              precio: servicio.precio,
              duracion: servicio.duracion,
              supabase_id: citaSupabase?.id
            });

            mensajeFinal = `✅ ¡Listo! Cita confirmada:\n\n📅 ${formatearFecha(fechaFinal)} a las ${data.cita_hora}\n💇‍♀️ ${servicio.nombre}\n👤 Con ${especialista.nombre}\n⏱️ ${servicio.duracion} min\n💰 $${servicio.precio}\n\nTe esperamos. ✨`;
            accionEjecutada = true;
          }
        }
        
        // Si falta especialista pero tiene todo lo demás → sugerir
        else if (data.accion === 'agendar' && servicio && data.cita_hora && !especialista) {
          const sugerencia = generarSugerenciaEspecialistas(especialistas, data.cita_servicio);
          mensajeFinal = `Perfecto, tengo: **${servicio.nombre}** para el ${formatearFecha(fechaFinal)} a las ${data.cita_hora}.\n\n${sugerencia}\n\n¿Con quién reservamos?`;
          accionEjecutada = false; // Esperar respuesta
        }
        
        // ============ CANCELAR ============
        else if (data.accion === 'cancelar') {
          const resultado = await cancelarCitaAirtable(userPhone);
          mensajeFinal = resultado 
            ? "✅ Cancelado. ¿Quieres agendar otra?"
            : "No encontré citas activas.";
          accionEjecutada = true;
        }
        
        // ============ REAGENDAR ============
        else if (data.accion === 'reagendar') {
          const resultado = await reagendarCitaAirtable(userPhone, { ...data, cita_fecha: fechaFinal });
          mensajeFinal = resultado
            ? `✅ Actualizado: ${formatearFecha(fechaFinal)} a las ${data.cita_hora}.`
            : "No pude actualizar. ¿Tienes una cita activa?";
          accionEjecutada = true;
        }

      } catch (e) {
        console.error('Error procesando:', e.message);
        mensajeFinal = "Disculpa, tuve un problema. ¿Me repites?";
      }
    }

    // 8. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: mensajeFinal, created_at: new Date().toISOString() }
    ]);

    // 9. RESPONDER
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${mensajeFinal}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error crítico:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento. ¿Me repites? 🌸</Message></Response>');
  }
}

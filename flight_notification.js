const Env = use('Env');
const Event = use('Event');
const Encryption = use('Encryption');

const fetch = use('node-fetch');

const Key = use('App/Models/Key');
const Flight = use('App/Models/Flight');
const Message = use('App/Models/FlightMessage');

const { updateFlight } = use('App/Utils/functions');

const moment = use('moment');
const admin = require("firebase-admin");

const jwt = require("jsonwebtoken");
const http2 = require('http2');
const flightService = use('App/Services/Flight');
const Airport = use('App/Models/Airport');
const LiveActivityIos = use('App/Services/LiveActivityIosService');
const Database = use('Database');

// Mapping of RabbitMQ status codes to app format
const mapFlightStatus = (statusCode, flightType) => {
    if (!statusCode) return '';

    // Special case: OPE depends on flight type
    if (statusCode === 'OPE') {
        // D = Departure (Salida) -> OFFBLOCK
        // I = Arrival (Llegada) -> INBLOCK
        return flightType === 'D' ? 'OFFBLOCK' : 'INBLOCK';
    }

    const statusMap = {
        'SCH': 'SCHEDULED',
        'DLY': 'DELAYED',
        'RET': 'DELAYED',
        'LSC': 'LAST CALL',
        'BRD': 'BOARDING',
        'CLS': 'CLOSED',
        'OBK': 'OFFBLOCK',
        'IBK': 'INBLOCK',
        'CAN': 'CANCELED',
        'CNL': 'CANCELLED'
    };

    return statusMap[statusCode] || statusCode;
};

Event.on('new::notification', async data => {
    try {
        console.log('Enviando notificacion');

        const flights = data.whereSearch.values.flights;
        const changes = data.extra;

        let bodyEs = data.actionParams.bodies.es_ES;
        let bodyEn = data.actionParams.bodies.en_US;

        console.log("Data flights: ", flights);
        console.log("========== VALIDACIÓN DE PAYLOAD COMPLETO DE RABBITMQ ==========");
        console.log("PAYLOAD COMPLETO:", JSON.stringify(data, null, 2));
        console.log("TIPO DE NOTIFICACIÓN:", bodyEs);
        console.log("===============================================================");
        console.log("========== VALIDACIÓN DE CAMPOS NUEVOS ==========");
        console.log("Changes object:", JSON.stringify(changes, null, 2));
        console.log("flightStatusCode (RabbitMQ):", changes.flightStatusCode, "| Tipo:", changes.flightType, "| Mapeado a 'status':", mapFlightStatus(changes.flightStatusCode, changes.flightType));
        console.log("iataOrigen (RabbitMQ) -> originCode:", changes.iataOrigen);
        console.log("aptoOrigen (RabbitMQ) -> originDescription:", changes.aptoOrigen);
        console.log("iataDestino (RabbitMQ) -> destinationCode:", changes.iataDestino);
        console.log("aptoDestino (RabbitMQ) -> destinationDescription:", changes.aptoDestino);
        console.log("fromDesk:", changes.fromDesk);
        console.log("toDesk:", changes.toDesk);
        console.log("gate:", changes.gate);
        console.log("terminal:", changes.terminal);
        console.log("=================================================");

        // Replace messages with the real flight status
        if (bodyEs.includes('Cerrado') && bodyEn.includes('Closed')) {
            bodyEs = bodyEs.replace('Cerrado', 'Abordado')
            bodyEn = bodyEn.replace('Closed', 'Boarded')
        } else if (bodyEs.includes('Despego')) {
            bodyEs = bodyEs.replace('Despego', 'Despegado')
        }

        // Verify if message includes status:null
        if (bodyEn.includes('Status:null') && bodyEs.includes('Estado:null')) {
            bodyEs = bodyEs.replace('Estado:null', '')
            bodyEn = bodyEn.replace('Status:null', '')
        }

        // Replace time change message for departed flights
        if (bodyEn.includes('Status:OBK') && bodyEs.includes('Estado:OBK')) {
            bodyEs = bodyEs.replace('La nueva hora del vuelo ', 'El vuelo ')
            bodyEs = bodyEs.replace(' es ', ' ha salido a las ')

            bodyEn = bodyEn.replace('New time to flight ', 'Flight ')
            bodyEn = bodyEn.replace(' is ', ' left at ')

            bodyEs = bodyEs.replace('Estado:OBK', '')
            bodyEn = bodyEn.replace('Status:OBK', '')
        }

        let titleEs = data.actionParams.titles.es_ES;
        let titleEn = data.actionParams.titles.en_US;
        console.log("Data flights: ", flights);

        if (flights && flights.length > 0) {

            let promisesFlights = flights.map(async flight => {

                const flightNumber = flight.numvue;
                const airport = flight.airport;
                const code = flight.codcia;
                const type = flight.type;

                const date = moment(flight.fprev).format('YYYY-MM-DD HH:mm:ss');
                const dateFormat = moment(flight.fprev).format('YYYY-MM-DDTHH:mm:ss.SSSZ');

                bodyEs = bodyEs.replace('##COMPANYCODE##', code);
                bodyEn = bodyEn.replace('##COMPANYCODE##', code);

                titleEs = titleEs.replace('##COMPANYCODE##', code);
                titleEn = titleEn.replace('##COMPANYCODE##', code);

                console.log('Flight ' + code + " " + flightNumber, (new Date()).toLocaleString());
                console.log(bodyEs)
                console.log('Date Filter', date);

                const f = await Flight
                    .query()
                    .where(builder => {
                        builder
                            .where('flight_number', flightNumber)
                            .where('apto', airport)
                            .whereRaw(`CONVERT(scheduled_date, DATETIME) = '${date}'`)
                    })
                    .first();


                if (f) {
                    console.log('Flight DB ---->', f.toJSON().id);

                    await Message.findOrCreate({
                        flight_id: f.id,
                        message_es: bodyEs
                    }, {
                        flight_id: f.id,
                        message_es: bodyEs,
                        message_en: bodyEn
                    });

                    const users = await f.suscribers().fetch();

                    if (users) {

                        const usersJson = users.toJSON();

                        // Filter tokens by receive_notifications flag in user_flights table.
                        // Only users who have opted in for this specific flight should receive
                        // push notifications.
                        const userIds = usersJson.map(u => u.id);
                        const userFlightsData = await Database.from('user_flights')
                            .whereIn('user_id', userIds)
                            .andWhere('flight_id', f.id);

                        const receiveMap = {};
                        userFlightsData.forEach(row => {
                            receiveMap[row.user_id] = row.receive_notifications === 1 || row.receive_notifications === true;
                        });

                        const tokens = usersJson
                            .filter((user) => user.fcmToken != null && receiveMap[user.id])
                            .map(u => u.fcmToken);

                        const message = {
                            tokens: tokens,
                            collapse_key: 'your_collapse_key',
                            data: {
                                titleEs,
                                titleEn,
                                bodyEs,
                                bodyEn,
                                flightNumber,
                                type,
                                airport,
                                scheduleDate: dateFormat,
                                company: code,
                                status: mapFlightStatus(changes.flightStatusCode, changes.flightType),
                                originCode: changes.iataOrigen || '',
                                originDescription: changes.aptoOrigen || '',
                                destinationCode: changes.iataDestino || '',
                                destinationDescription: changes.aptoDestino || '',
                                fromDesk: changes.fromDesk || '',
                                toDesk: changes.toDesk || '',
                                gate: changes.gate || '',
                                terminal: changes.terminal || '',
                                "notificationType": "push-notification",
                                "updatedAt": moment(new Date()).format('YYYY-MM-DDTHH:mm:ss')
                            },
                            android: {
                                priority: 'high'
                            },
                            apns: {
                                headers: {
                                    'apns-priority': "10",
                                },
                                payload: {
                                    aps: {
                                        alert: {
                                            title: titleEs,
                                            body: bodyEs
                                        },
                                        badge: 0,
                                        sound: 'default',
                                        mutableContent: true,
                                        contentAvailable: false
                                    }
                                },
                            },
                        };

                        await enviarNotificaciones(message, flightNumber, code);
                        await validateDelayedFlight(message, changes, f, code);
                        await sentNotificationLiveActivity(usersJson, changes);

                    }
                }
            })
            await Promise.all(promisesFlights);
        } else {
            console.log('No flights data, logging object')
            console.log(data)
        }

    } catch (error) {
        console.log(error);
    }

    // Uncomment this section if theres communication between PROD -> testing/QA
    // If this is prod environment, it should notify QA & testing
    /*const isProd = Env.get('PROD', "false") == "true";
    if (isProd) {
        try {
            await notifyOtherEnvs(`${Env.getOrFail('TESTING_ENDPOINT')}/api/v1/flights/notify`, {
                data: data,
                key: Env.getOrFail('NOTIFY_KEY')
            })
            await notifyOtherEnvs(`${Env.getOrFail('QA_ENDPOINT')}/api/v1/flights/notify`, {
                data: data,
                key: Env.getOrFail('NOTIFY_KEY')
            })
        } catch (error) {
            console.log(error)
        }
    }*/
});


const enviarNotificaciones = async (message, flightNumber, code) => {
    try {
        if (!message.tokens || message.tokens.length === 0) {
            console.log(`No tokens to send for flight ${code} ${flightNumber}`);
            return;
        }
        console.log("Push notification body: ", message)
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log('Flight '+code+" "+flightNumber+' successfully sent '+(new Date()).toLocaleString(), response.responses);
    } catch (error) {
        console.log('Something has gone wrong! Flight: '+flightNumber, error)
    }
}

const validateDelayedFlight = async (message, changes, flight, code) => {
    try {
        if (changes.estimatedDate && changes.scheduledDate) {
            const sch = moment(changes.scheduledDate)
            const est = moment(changes.estimatedDate)

            const diffInMills = Math.abs(sch.diff(est))
            const diffInMins = moment.duration(diffInMills).minutes()

            const flightWasDelayed = diffInMins >= 15 && est > sch
            console.log(`Flight ${code} ${flight.flight_number} delayed: ${flightWasDelayed}`)

            if (flightWasDelayed) {
                // Should send a delayed flight notification
                let bodyEn = `The flight ${code} ${flight.flight_number} has changed status to Delayed.`
                let bodyEs = `El vuelo ${code} ${flight.flight_number} ha cambiado de estado a Retrasado.`
                let titleEn = `Status changed in flight ${code} ${flight.flight_number}`
                let titleEs = `Cambio de estado en el vuelo ${code} ${flight.flight_number}`

                // Verify stored message
                const storedMsg = await Message.query().where({
                    flight_id: flight.id,
                    message_es: bodyEs
                }).first();

                if (!storedMsg) {
                    await Message.findOrCreate({
                        flight_id: flight.id,
                        message_es: bodyEs
                    }, {
                        flight_id: flight.id,
                        message_es: bodyEs,
                        message_en: bodyEn
                    })

                    // Edit message based on original object
                    message.data.titleEs = titleEs
                    message.data.bodyEs = bodyEs
                    message.data.titleEn = titleEn
                    message.data.bodyEn = bodyEn

                    // Send FCM notification (tokens already filtered by receive_notifications)
                    const response = await admin.messaging().sendEachForMulticast(message);
                    console.log('Delayed flight '+code+" "+flight.flight_number+' successfully sent '+(new Date()).toLocaleString(), response);
                }
            }
        }
    } catch (error) {
        console.log('Something has gone wrong! Delayed flight: '+flight.flight_number, error)
    }
}

const sentNotificationLiveActivity = async(users, changesFlight) => {
    console.log("scheduledDate RAW:", changesFlight.scheduledDate);
    console.log("estimatedDate RAW:", changesFlight.estimatedDate);
    console.log("scheduledDate converted:", moment.utc(changesFlight.scheduledDate).format('YYYY-MM-DD HH:mm:ss'));
    const scheduledDate = moment.utc(changesFlight.scheduledDate).format('YYYY-MM-DD[T]HH:mm:ss.SSSZ');
    const currentFlightCode = `${changesFlight.airportCode}_${changesFlight.flightType}_${changesFlight.flightNumber}_${scheduledDate}_${changesFlight.flightCompany}`;
    console.log("currentFlightCode", currentFlightCode);
    try {
       const { tokensIos, tokensAndroid } = await getUsersForNotification(users, currentFlightCode, changesFlight.flightId);
       console.log("tokensIos", tokensIos);
       console.log("tokensAndroid", tokensAndroid);

       if (tokensIos.length > 0 || tokensAndroid.length > 0) {
            const reqFlight = {
                "flightNumber": changesFlight.flightNumber,
                "apto": changesFlight.airportCode,
                "endpointType": "flights",
                "type": changesFlight.flightType,
                "company": changesFlight.flightCompany,
                "destinationCode": changesFlight.iataDestino || '',
                "destinationDescription": changesFlight.aptoDestino || '',
                "originCode": changesFlight.iataOrigen || '',
                "originDescription": changesFlight.aptoOrigen || '',
                "status": mapFlightStatus(changesFlight.flightStatusCode, changesFlight.flightType),
                "fromDesk": changesFlight.fromDesk || '',
                "toDesk": changesFlight.toDesk || '',
                "gate": changesFlight.gate || '',
                "terminal": changesFlight.terminal || '',
                "scheduledDate": scheduledDate,
                "estimatedDate": moment(changesFlight.estimatedDate).format('YYYY-MM-DD[T]HH:mm:ss.SSSZ')
            }
            await sendLiveActivityAndroid(tokensAndroid, reqFlight);
            await LiveActivityIos.sendToMultiple(tokensIos, reqFlight);
       }
    } catch(error) {
        console.log("Error sending live activities: ", error);
    }
}

const getUsersForNotification = async (users, currentFlightCode, flightId) => {
    console.log("=== DEBUGGING getUsersForNotification ===");
    console.log("Looking for currentFlightCode:", currentFlightCode);
    console.log("Total users:", users.length);

    const userIds = users.map(u => u.id);
    // Consult batch to user_flights
    const userFlights = await Database.from('user_flights')
        .whereIn('user_id', userIds)
        .andWhere('flight_id', flightId);

    // Map user_id => receive_notifications
    const receiveMap = {};
    userFlights.forEach(row => {
        receiveMap[row.user_id] = row.receive_notifications === 1 || row.receive_notifications === true;
    });

    return users.reduce((acc, user, index) => {
        const receiveNotifications = receiveMap[user.id] || false;
        console.log(`User ${index}: currentFlight='${user.currentFlight}', matches=${user.currentFlight === currentFlightCode}, os=${user.os}, receive_notifications(db)=${receiveNotifications}`);

        if (user.currentFlight !== currentFlightCode) return acc;
        if (!receiveNotifications) return acc;

        if (user.os === 'ios' && user.notificationToken) {
            acc.tokensIos.push(user.notificationToken);
        } else if (user.os === 'android' && user.fcmToken) {
            acc.tokensAndroid.push(user.fcmToken);
        }

        return acc;
    }, { tokensIos: [], tokensAndroid: [] });
};


const sendLiveActivityAndroid = async (tokens, flightDataNoty) => {
    try {
        if (tokens.length == 0) return;
        const updatedAt = moment(new Date()).format('YYYY-MM-DDTHH:mm:ss');
        const message = {
            tokens: tokens,
            data: {
                ...flightDataNoty,
                "updatedAt": updatedAt,
                "notificationType": "live-activities"
            },
            android: {
                priority: 'high'
            }
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log("Sent live activity android:", response);
    } catch (error){
        console.log("Error sending live activity Android:", error);
    }
}

const notifyOtherEnvs = async (url, body = {}) => {
    try {
        const response = await fetch(url, {
            method: 'post',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('Notify flight response ->', response)
    } catch (error) {
        console.log('Notify flight error ->', error)
    }
}

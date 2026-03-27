'use strict'

const Env = use('Env');
const moment = use('moment');
const apn = use('@parse/node-apn');
const Airport = use('App/Models/Airport');
const UserFlight = use('App/Models/UserFlight');

class LiveActivityIosService {
  provider = null;

  constructor() {
    this.initClient()
  }

   initClient = () => {
        console.log('--- ESTABLECIENDO CONEXIÓN HTTP/2 CON APPLE ---')
        var options = {
            token: {
                key: Env.getOrFail('APN_PRIVATE_KEY').replace(/\\n/g, '\n'),
                keyId: Env.getOrFail('APN_KEY_ID'),
                teamId: Env.getOrFail('APN_TEAM_ID')
            },
            production: Env.getOrFail('APN_PRODUCTION') === 'true'
        };

        this.provider = new apn.Provider(options);
  }

   async sendToMultiple(tokens, flightDataNoty) {
     try {
        // tokens: Only users with receive_notifications=true should be passed here (filter outside)
        console.log("tokens IOS", tokens);
        if (tokens.length == 0) return;

        const date = new Date();
        const unixTimestamp = Math.floor(date.getTime() / 1000);
        const notification = new apn.Notification();
        notification.pushType = 'liveactivity';
        notification.priority = 10;
        notification.topic = `${Env.getOrFail('APN_BUNDLE_ID')}.push-type.liveactivity`;

        let payload = {
            aps: {
                'timestamp': unixTimestamp,
                'event': 'update',
                'relevance-score': 100.0,
                'stale-date': unixTimestamp + (60 * 60 * 8),
                'content-state': {
                    ...flightDataNoty,
                    'updatedAt': unixTimestamp
                }
            },
        }

        const isClosed = await this.isFlightClosed(flightDataNoty.apto, flightDataNoty.status, flightDataNoty.estimatedDate);
        console.log("Closed Activity: ", isClosed);
        console.log("unixTimestamp: ", unixTimestamp, ", dismissal-date: ", unixTimestamp + 30);
        if (isClosed) {
            payload.aps["dismissal-date"] = unixTimestamp + 30; // 30 seconds after close
            payload.aps.event = "end";
            // Update receive_notifications to false for all users of this flight
            // NOTE: flightId (camelCase) must be present in flightDataNoty
            if (flightDataNoty.flightId) {
                await UserFlight.query().where({ flight_id: flightDataNoty.flightId }).update({ receive_notifications: false });
            }
        }

        notification.rawPayload = payload;

        console.log("notification rawPayload: ", notification.rawPayload.aps);
        const response = await this.provider.send(notification, tokens);

        if (response.failed.length > 0) {
             for (const failure of response.failed) {
                console.log("Response APN:", failure.response);
             }
        }

     } catch (error) {
         console.log("Error sending live notifications iOS", error);
     }
}

isFlightClosed = async(airportCode, status, estimatedDate) => {
    let closed = false;

    if (status == "CLOSED" || status == "CANCELLED" || status == "CANCELED") {
        closed = true;
    } else if (status == 'INBLOCK' || status == 'OFFBLOCK') {
        const airport = await Airport
            .query()
            .where({
                abbreviation: airportCode,
                alive: true
            })
            .select('id', 'time_zone')
            .first();

        if (airport && airport.time_zone) {
            const offset = parseInt(airport.time_zone.split('-')[1]);
            // estimatedDate is the local time of the airport
            const estimatedDateLocal = moment(estimatedDate).utcOffset(-offset, true).add(30, 'minutes');

            const nowLocal = moment().utcOffset(-offset);

            console.log("EstimatedDateFlight (local aeropuerto +30min):", estimatedDateLocal.format('YYYY-MM-DD HH:mm:ss'));
            console.log("Now (local aeropuerto):", nowLocal.format('YYYY-MM-DD HH:mm:ss'));
            console.log("Status:", status);
            console.log("isSameOrBefore:", estimatedDateLocal.isSameOrBefore(nowLocal));

            if (estimatedDateLocal.isSameOrBefore(nowLocal)) {
                closed = true;
            }
        }
    }
    console.log("Final closed value:", closed);
    return closed;
}

}


module.exports = new LiveActivityIosService();

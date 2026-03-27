const admin = require('firebase-admin');
const db = require('./db'); // database connection

/**
 * Sends push notifications to users subscribed to a flight,
 * filtering only those who have receive_notifications enabled
 * in the user_flights table.
 *
 * @param {number} flightId - The ID of the flight to notify about
 * @param {object} payload - The notification payload (title, body, data)
 */
async function sendFlightNotification(flightId, payload) {
  const { title, body, data = {} } = payload;

  let rows;
  try {
    // Query tokens only for users who have opted in to receive notifications
    // for this specific flight via the receive_notifications flag in user_flights
    [rows] = await db.query(
      `SELECT u.push_token
       FROM users u
       INNER JOIN user_flights uf ON uf.user_id = u.id
       WHERE uf.flight_id = ?
         AND uf.receive_notifications = 1
         AND u.push_token IS NOT NULL
         AND u.push_token != ''`,
      [flightId],
    );
  } catch (err) {
    console.error(`Database error fetching tokens for flight ${flightId}:`, err);
    throw err;
  }

  const tokens = rows
    .map((row) => row.push_token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    console.log(`No users with notifications enabled for flight ${flightId}`);
    return;
  }

  const message = {
    notification: {
      title,
      body,
    },
    data,
    tokens,
  };

  let response;
  try {
    response = await admin.messaging().sendEachForMulticast(message);
  } catch (err) {
    console.error(`Firebase messaging error for flight ${flightId}:`, err);
    throw err;
  }

  console.log(
    `Notifications sent for flight ${flightId}: ` +
      `${response.successCount} succeeded, ${response.failureCount} failed`,
  );

  if (response.failureCount > 0) {
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error(`Failed to send to token ${tokens[idx]}:`, resp.error);
      }
    });
  }
}

module.exports = { sendFlightNotification };

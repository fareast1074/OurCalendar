# Pastel Broski Calendar

This version copies the **Broski Planner concept** while keeping the pastel/light-maroon mobile design.

Included:
- username + password only; no email and no Firebase Authentication
- Firebase Realtime Database for users + shared events
- real-time event syncing
- invite/include users with checkboxes
- edit/delete events
- All / Just Me / By User filters
- upcoming/incoming plan feed
- next-event countdown
- monthly plan metric
- pastel themes with light maroon default
- GitHub Pages / Android / iOS browser friendly UI

## Firebase
Use the Firebase project already configured in `firebase-config.js`. In Realtime Database, a simple open ruleset is required for the no-auth concept:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

This is intentionally a simple app and is **not secure authentication**. Passwords are stored directly to match the requested concept. Do not reuse real passwords.

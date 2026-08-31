# Pastel Shared Calendar

Mobile-first shared calendar for GitHub Pages + Firebase Realtime Database.

## Login

The app uses a simple username + password stored in Firebase Realtime Database. There is **no email address** and **no Firebase Authentication provider** involved.

Passwords are stored as SHA-256 hashes. This keeps the same simple client-side login model used by the Broski Planner style setup.

## Firebase setup

1. Open your Firebase project: `trip-planner-edb3f`.
2. Make sure **Realtime Database** is enabled.
3. The app uses the `databaseURL` already present in `firebase-config.js`.
4. For the intentionally open/simple setup, the included `database.rules.json` can be used as the Realtime Database rules.
5. Publish the folder to GitHub Pages.

You do **not** need Cloud Firestore.
You do **not** need to enable Firebase Authentication.

## Realtime Database structure

The app stores everything under a simple RTDB tree:

```text
users/
  username/
    username
    displayName
    passwordHash
    createdAt
    calendarRefs/
      calendarId/
        calendarId
        joinedAt

calendars/
  calendarId/
    name
    theme
    shareCode
    createdBy
    createdAt
    members/
      username/
        role
        name
        username
        joinedAt
    events/
      eventId/
        title
        date
        time
        calendarId
        location
        notes
        createdBy
        createdAt
        updatedAt

joinCodes/
  SHARECODE/
    calendarId
    createdBy
    createdAt
```

## Shared calendars

- Create an account with a username and password.
- Create a calendar and share the generated 6-character code.
- Another user creates their own account and enters the code.
- Both users receive live updates through Firebase Realtime Database listeners.
- Event creation uses `push()`, while edits use `update()` and deletes use `remove()`, matching the simple RTDB pattern used by the Broski Planner.

## Mobile

The UI is designed for phone screens and can be added to the home screen from Safari or Chrome. The included manifest and service worker provide the PWA shell.

# Pastel Shared Calendar

Mobile-first shared calendar for GitHub Pages + Firebase Firestore.

## Login

The app uses a simple username + password stored in Firestore. There is **no email address** and **no Firebase Authentication provider** involved.

Passwords are stored as SHA-256 hashes rather than raw text, but this is **not a secure authentication system** because Firestore is intentionally open in the supplied rules. Anyone who can access the app can potentially read or modify the Firestore data.

## Firebase setup

1. Open your Firebase project: `trip-planner-edb3f`.
2. Create/enable Cloud Firestore.
3. Open Firestore Rules and paste the included `firestore.rules`.
4. Keep `firebase-config.js` with your Firebase web config.
5. Publish the folder to GitHub Pages.

You do **not** need to enable Firebase Authentication.

## Shared calendars

- Create an account with a username and password.
- Create a calendar and share its 6-character code.
- Another user creates their own username/password and enters the code.
- Events are stored in Firestore and sync in real time between users of that shared calendar.

## Mobile

The UI is designed for phone screens and can be added to the home screen from Safari or Chrome. The included manifest and service worker provide the PWA shell.

# Protocol Timer PWA

Protocol Timer PWA is a browser-based experiment protocol timer designed for running and logging experimental procedures on smartphones, tablets, and desktop browsers.

This project was developed with AI assistance.

## Overview

This app helps users create experiment protocols, run protocol steps as timers, record start and finish times, and export experiment logs.

It is intended as a lightweight experimental support tool, especially for situations where multiple experimental runs need to be managed in parallel.

## Features

* Create and edit experiment protocols
* Save protocol presets in the browser
* Run multiple experiments in parallel
* Start, pause, resume, finish, skip, and reset steps
* Extend or shorten step duration with a reason
* Add steps during an experiment with a reason
* Record operation logs
* Export step summaries as CSV
* Export event logs as CSV
* Export run reports as HTML
* Import and export protocols as JSON
* Alarm when a step reaches its scheduled end time
* Optional one-minute-before notification for longer steps
* PWA support for adding the app to a smartphone or tablet home screen

## How to use on iPhone or iPad

Open the published URL in Safari.

Then:

1. Tap the Share button.
2. Tap **Add to Home Screen**.
3. Launch Protocol Timer from the home screen icon.

For reliable timer and alarm behavior, keep the app open during experiments. Mobile operating systems may restrict alarms, notifications, or background activity when the screen is locked or the app is in the background.

## Data storage and privacy

This app is designed as a client-side PWA.

The app code is hosted publicly, but experiment data entered by users is stored locally in the user's own browser storage.

In normal use, the following data is stored locally on the user's device:

* Protocol names
* Step names
* Planned durations
* Experiment run names
* Start and finish times
* Notes
* Skip reasons
* Extend and shorten reasons
* Event logs

This data is not automatically uploaded to GitHub or any external server by this app.

However, users should be careful when exporting files. Exported JSON, CSV, or HTML files may contain experiment details. If those files are manually uploaded to GitHub, attached to emails, saved to shared cloud folders, or otherwise shared, their contents may become visible to others.

Do not enter confidential information, personal information, patient information, unpublished experimental details, or sensitive sample identifiers unless you understand and accept the risks of local browser storage and exported files.

## Important limitations

This app is provided as an experimental support tool. It should not be used as the sole timing or logging system for critical experiments.

Please use a backup timer or independent record-keeping method when timing accuracy is important.

Known limitations include:

* Browser timers may be affected by device sleep, screen lock, low power mode, or background restrictions.
* Mobile browsers may restrict alarm sounds and notifications.
* Local browser data may be deleted if site data is cleared.
* Data stored in one browser may not automatically appear in another browser or device.
* Exported files must be managed carefully by the user.

## Safety notice

The authors and maintainers do not guarantee that the timer, alarm, notification, or logging functions will work correctly in all environments.

Before using this app in real experiments, test it with non-critical workflows and confirm that it behaves as expected on your device and browser.

## Installation for development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build the production version:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Deployment

This app can be deployed as a static site using services such as GitHub Pages, Netlify, Vercel, or similar static hosting services.

When using GitHub Pages, only the app code is published. User-created protocols and experiment logs remain in each user's browser storage unless manually exported and shared.

## Recommended usage policy

For safer use:

* Do not upload experiment data files to the public GitHub repository.
* Do not include confidential experiment details in README files, Issues, Pull Requests, or public screenshots.
* Avoid entering personal information or patient information into protocol names, step names, or notes.
* Export important records after experiments and store them in an appropriate approved location.
* Use a backup timer for important or time-sensitive experiments.
* Test the app before relying on it in real workflows.

## AI assistance disclosure

This project was developed with AI assistance. The code should be reviewed, tested, and validated before use in real experimental workflows.

AI-generated or AI-assisted code may contain bugs, security issues, or unexpected behavior. Users are responsible for evaluating whether the app is appropriate for their intended use.

## License

License

This project is licensed under the MIT License.

See the LICENSE file for details.

This project uses open-source libraries such as React, Vite, TypeScript, and related npm packages. Their respective copyrights and licenses remain with their original authors and projects.

## Disclaimer

This software is provided as-is, without warranty of any kind.

The app is not a certified laboratory instrument, medical device, clinical system, or validated quality-control tool. The user is responsible for verifying timing accuracy, data integrity, and suitability for their own experimental workflow.

The authors and maintainers are not responsible for experimental errors, data loss, missed alarms, incorrect timing, or any other damages arising from use of this software.

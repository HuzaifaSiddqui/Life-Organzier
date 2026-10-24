# Map place picker: device checklist (FR-LB-001)

Run on a real Android phone after `npx expo run:android` (react-native-webview is a native module). Use a Pro
account with location reminders on. Tick each line in light and dark mode, and once with the app in Urdu.

## Open and search
- [ ] Add a location to a task: the picker opens with the map centred on where you are (pin not placed yet). With
      location access off: centred on your saved Home, or on Pakistan with no Home.
- [ ] "© OpenStreetMap contributors" is visible on the map; tapping it opens the browser, not the map.
- [ ] Type 2 letters: "Type at least 3 letters". Type a place: results list under the search AND accent dots on the map.
- [ ] Tap a result: the pin moves there, the map recentres, name and address fill in.
- [ ] Tap a result dot on the map: same as tapping it in the list.

## Pin and radius
- [ ] Tap the map: the pin jumps there; ~0.6 s later the address (and the name, if you haven't typed one) updates.
- [ ] Drag the pin: the circle follows while dragging; nothing is looked up until you let go.
- [ ] Type your own name, then drag the pin: your name stays, only the address changes.
- [ ] Precise / Nearby / Area: the circle grows and shrinks at once; the text says 200 m / 350 m / 750 m.
- [ ] Home / University / Office chips set the name.
- [ ] "Use current location": the pin and map move to you, name and address fill in.

## Keyboard
- [ ] Tap the search field: the keyboard opens, the search stays visible, the map collapses and results fill the space.
- [ ] Tap the name field: the keyboard opens, the name field and Save stay visible above it.
- [ ] Close the keyboard: the map comes back where it was (it doesn't reload).

## Offline
- [ ] Airplane mode, open the picker: after a few seconds a short note with "Try again" replaces the map;
      "Use current location", "Enter name manually" and Save still work. No crash.
- [ ] Still in the picker, turn airplane mode off: the map comes back by itself within a few seconds.
- [ ] Airplane mode on again → note → airplane mode off → tap "Try again": the map loads.

## Theme
- [ ] With the picker open and a pin placed, switch the phone between light and dark: the map reloads briefly with
      the new colours; pin, circle and result dots are still there.

## Editing and saving
- [ ] Task detail → tap a location chip → change it: the map opens on that place with its circle; change the radius, Save.
- [ ] On a task, drag the pin elsewhere and Save: the task now uses the new place (the old saved place is unchanged).
- [ ] Settings → Saved places → open a place: drag the pin (or pick a result) and Save: the same place, same name,
      new position (check the address in the list).
- [ ] Onboarding (first time location reminders are turned on) → Home → pick a spot: it is saved as "Home".
- [ ] Create a new task with a location from the task form: the place is attached after the task is saved.
- [ ] Walk (or mock-locate) into the circle of a place with an open task: the arrival notification still comes.

## Saved places screen
- [ ] Settings → Saved places: a map above the list shows a dot for every place, all in view.
- [ ] Scrolling the screen over the map scrolls the list (the map doesn't pan); pinch zooms the map.
- [ ] Tap a dot: that place opens for editing. Offline: a short note replaces the map; the list works.

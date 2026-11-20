# Home Assistant widget

Shows and controls your [Home Assistant](https://www.home-assistant.io/) entities
from the PS5 Welcome Hub: lights, switches, sensors, climate, covers, locks, media
players and more. The tile shows the entities you choose as cards, with live state; the
full-screen page adds sliders, temperature and mode controls, and the entity
chooser.

## Setup

1. In Home Assistant, create a user for the console. A non-admin user is enough
   and safer: the token can do anything that user can.
2. Signed in as that user, open your profile, then **Security**, and create a
   **long-lived access token**.
3. In this folder's `config.json`, set:
   - `haUrl`: your server's address as the console reaches it, for example
     `http://192.168.1.10:8123`. Use the IP address: `homeassistant.local` may not
     resolve on the console.
   - `haToken`: the token.
4. Copy the folder to `/data/wh-widgets/home-assistant/` on the console.
5. Sign out and back in, then add **Home Assistant** from **Edit Widgets**.
6. Press X on the tile to choose your entities.

## Using it

**On the tile**

- Each entity is a card: an icon, its state and its name. Cards of entities that
  are on (or open, unlocked, playing, home, heating) are brighter.
- X enters the tile. Arrows pick a card, X runs its action, Circle leaves.
  Read-only entities (sensors) can't be picked.
- Square opens the full page.
- The tile shows as many cards as fit its size, in the order you chose them. When
  there are more, the title shows the range (`1-9 of 18`): inside the tile, Down on
  the last row and Up on the first scroll to the rest.
- **Cards per row** in Options: 1, 2 or 3 (3 by default). An XL tile shows twice
  as many.

**On the page**

- Every chosen entity, with the control that suits it: a switch, a slider, a
  dropdown or a button.
- Sliders: X starts adjusting, left and right change the value, X sets it. The
  value shows under the title while you adjust it.
- **Choose entities** opens the chooser: turn entities on or off, filter by type
  with **Show**, or search by name. **Done** goes back.
- Circle closes the page.

**What X does**

| entity | X on the tile | extra controls on the page |
|---|---|---|
| light | toggle | brightness slider |
| switch, input boolean, automation, siren, humidifier, valve | toggle | |
| fan | toggle | speed slider |
| scene, script | activate / run | |
| button, input button | press | |
| cover | open, close, or stop while moving | position slider |
| lock | lock, or unlock after you confirm | |
| media player | play / pause (turn on when off) | volume slider |
| vacuum | start, or return to the dock | |
| lawn mower | start, or dock | |
| select, input select | next option | |
| number, input number | | value slider |
| climate | opens the page | target temperature (or low and high), mode |
| water heater | opens the page | target temperature, operation mode |
| anything else (sensors, weather, ...) | shows the state | |

Unlocking a lock, and opening a garage door or gate, ask for confirmation first.

## When something is wrong

| the tile says | check |
|---|---|
| Add haUrl and haToken to config.json | `config.json` still has the placeholders |
| Home Assistant rejected the token | the token was revoked or mistyped: make a new one and sign out and back in |
| Can't reach ..., retrying | the address and port, that the console and the server are on the same network, and the server's firewall. The widget retries after 2, 5, 10, then every 30 seconds |

Lines tagged `[widget:home-assistant]` in `/data/wh-widgets/wh.log` show the
connection state and any failed action. The token is never logged.

## Notes

- Anyone who can read the console's files over FTP can read the token.
- Plain `http://` on your home network is tested. `https://` (Nabu Casa, or a
  reverse proxy) is not yet.
- The chosen entities are saved for each PS5 user.
- The widget connects only while the hub is on screen, and disconnects a few
  seconds after it leaves.
- Tested on firmware 13.20 against Home Assistant 2026.11 and its demo entities.

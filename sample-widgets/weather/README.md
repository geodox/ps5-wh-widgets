# Weather widget

Current weather and a forecast for the places you save, anywhere in the world.
Data comes from [Open-Meteo](https://open-meteo.com/), which needs no account or
key. Based on the Weather widget by
[VintendoPower](https://github.com/manchildtechnologies-ui).

## Setup

1. Copy this folder to `/data/wh-widgets/weather/` on the console.
2. Sign out and back in, then add **Weather** from **Edit Widgets**.
3. Press X on the tile, choose **Add a place**, and search.

The console needs internet access to `open-meteo.com`.

## Places

- Search by city name or postal code, in any country: for example `Tokyo`,
  `75001`, `SW1A 1AA` or `München`. Each result shows its region, country and
  coordinates, so places with the same name are easy to tell apart.
- Place names come in the console's language when Open-Meteo has them.
- Up to 20 places are saved, for each PS5 user.
- On the tile, **L1** and **R1** switch between your places.
- On the page, X on a place shows it on the tile. **Remove a place** asks before
  removing one.

## On the tile

| size | shows |
|---|---|
| DEFAULT | condition, temperature, today's high and low, feels like |
| LARGE | adds the 5-day forecast |
| FULL | adds humidity, wind, today's rain chance, local time, and the next 6 hours |

- The title shows the place's name and its local time. The clock follows the
  console's 12/24-hour setting.
- **X** opens your places. **Square** refreshes now.
- The weather refreshes every 15 minutes while the hub is on screen. After a
  failed load it retries after 2 minutes.
- The background photo and condition icons are hidden in edit mode. They come
  back when you leave it.

## Options

| setting | choices |
|---|---|
| Temperature | Console region (°F in the US and a few other countries, °C elsewhere), Celsius, Fahrenheit |
| Wind speed | Console region (mph in the US and UK, km/h elsewhere), km/h, mph, m/s, knots |
| Background photos | on (default) or off for the plain stock look |

## Files

- `icon-*.png` and `glyph.png` are drawn by
  [`tools/gen_weather_icons.py`](../../tools/gen_weather_icons.py).
- `weather-*.jpg` are the background photos from the original widget.

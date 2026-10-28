# Credits and licences

This dashboard is a static viewer. It vendors two MIT-licensed libraries and
reads data from a separate public repository. No third-party code is fetched at
runtime.

## Chart.js

- Source: <https://github.com/chartjs/Chart.js>
- Commit / version: 4.4.7 (`chart.js@4.4.7`, downloaded from
  <https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js>)
- Licence: MIT
- Used for: all charts (`vendor/chart.umd.min.js`)
- Modified: no

## PapaParse

- Source: <https://github.com/mholt/PapaParse>
- Commit / version: 5.4.1 (`papaparse@5.4.1`, downloaded from
  <https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js>)
- Licence: MIT
- Used for: CSV parsing (`vendor/papaparse.min.js`)
- Modified: no

## Data

- Source: <https://github.com/jagdishsah126/nepse-floorsheet-archive>
- Used for: `Summary/<date>_brokers.csv` files, fetched at runtime from
  `raw.githubusercontent.com`
- Modified: no; the dashboard only reads the published files

The archive is public NEPSE floorsheet data. NEPSE data belongs to its
respective owners. This project is an independent visualizer, not affiliated
with NEPSE, and is not investment advice.

## MIT licence text

Both vendored libraries use the MIT licence:

```text
The MIT License (MIT)

Copyright (c) 2014-2024 Chart.js Contributors
Copyright (c) 2015 Matthew Holt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

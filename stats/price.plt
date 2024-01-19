if (!exists("fname")) {
    print "Usage: gnuplot -e \"fname='input.csv'\" price.plt"
    exit 1
}

# Output PNG file name
output_name = sprintf('img/%s.png', strstrt(fname, ".csv") > 0 ? system('basename "'.fname.'" | cut -d. -f1') : fname)

tfmt = "%Y-%m-%dT%H:%MZ"

set key autotitle columnhead
set datafile separator ","
set terminal unknown
set print "-"
set xdata time
set timefmt tfmt
set format x "%a %m/%d"
set xtics rotate by -45
set xlabel "Date"
set ylabel "Price (EUR)"
set title sprintf("Journey Price Over Time for %s", fname)
set grid

# Fit function
a = 1e-18
b = 1e-12
c = -1e-6
d = 1e2
start=0
f(x) = a*((x-start)**3) + b*((x-start)**2) + c*(x-start) + d

plot fname using 1:2 with linespoints lc rgb "black" pt 7 ps 2 title "Price", f(x) lc rgb "red" title "Polynomial Fit (a*x^3 + b*x^2 + c*x + d))"

# Define a function for shaded weekends
shaded_weekend(start, end) = sprintf('set object rect from "%s", graph 0 to "%s", graph 1 behind fc rgb "blue" fillstyle transparent solid 0.5 noborder', start, end)

first_date = strftime(tfmt, GPVAL_DATA_X_MIN)
last_date = strftime(tfmt, GPVAL_DATA_X_MAX)

# Convert the first date to a timestamp
current_date = strptime(tfmt, first_date)

while (current_date <= strptime(tfmt, last_date)) {
    if (strftime("%w", current_date) == 5) {  # Check if it's Friday
        weekend_start = strftime(tfmt, current_date)
        weekend_end = strftime(tfmt, current_date + 2 * 86400)  # Assuming weekends are 2 days
        weekend = shaded_weekend(weekend_start, weekend_end)
        eval weekend
    }
    current_date = current_date + 86400  # Increment by one day (86400 seconds)
}

start = GPVAL_DATA_X_MIN
fit f(x) fname using 1:2 via a, b, c, d

set terminal pngcairo size 1200,800 enhanced font 'Verdana,12'
set output output_name

replot

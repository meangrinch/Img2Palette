# Img2Palette

A simple python application that generates a color palette from an image.

## Features

* Select an image file (various formats supported).
* Adjust the number of colors in the generated palette (up to 256).
* Palettes are sorted by their perceptual color difference.
* Palettes are outputted as a PNG file (3x3px swatch size)

## Requirements

* Python 3.x
* tkinter
* Pillow (PIL)
* scikit-image
* numpy

You can install these dependencies using pip:

```bash
pip install tkinter Pillow scikit-image numpy
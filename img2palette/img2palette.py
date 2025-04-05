import os
import tkinter as tk
from tkinter import filedialog, Frame, Label, Button, Scale, HORIZONTAL, Toplevel

import numpy as np
from PIL import Image, ImageTk
from sklearn.cluster import KMeans
from skimage import color
from skimage.color import deltaE_ciede2000

class Img2Palette:
    """
    Main application class for extracting color palettes from images.
    
    Provides functionality to load images, extract dominant colors,
    preview and save color palettes sorted by perceptual similarity.
    """
    def __init__(self, root):
        """
        Initialize the application with a tkinter root window.
        
        Args:
            root: The tkinter root window
        """
        self.root = root
        self.img = None
        self.palette = None
        self.file_path = None
        self.preview_window = None
        self.setup_ui()

    def setup_ui(self):
        """Set up the user interface elements and bindings."""
        self.root.title("Img2Palette")
        self.root.geometry("250x450")
        self.root.resizable(False, False)
        self.image_frame = Frame(self.root, width=256, height=256)
        self.image_frame.pack_propagate(False)
        self.image_frame.pack(pady=5)
        self.img_label = Label(self.image_frame)
        self.img_label.pack(expand=True)
        Button(self.root, text="Select Image", command=self.get_image).pack(pady=5)
        Label(self.root, text="Colors in Palette:").pack(pady=(5, 0))
        self.scale = Scale(self.root, from_=1, to=256, orient=HORIZONTAL, highlightthickness=0)
        self.scale.pack()
        self.scale.focus_set()
        self.scale.bind("<Left>", self.change_scale(-1))
        self.scale.bind("<Down>", self.change_scale(-1))
        self.scale.bind("<Right>", self.change_scale(1))
        self.scale.bind("<Up>", self.change_scale(1))
        Button(self.root, text="Preview Palette", command=self.preview_palette).pack(pady=5)
        Button(self.root, text="Save Color Palette", command=self.create_and_save_palette).pack(pady=5)

    def get_image(self):
        """Open file dialog to select an image and display it."""
        self.file_path = filedialog.askopenfilename()
        if not self.file_path:
            return
        self.img = Image.open(self.file_path).convert('RGB')
        self.img.thumbnail((256, 256), Image.Resampling.LANCZOS)
        colors = np.array(self.img).reshape(-1, 3)
        max_colors = min(len(np.unique(colors, axis=0)), 256)
        self.scale.config(to=max_colors)
        self.img_preview = ImageTk.PhotoImage(self.img)
        self.img_label.config(image=self.img_preview)

    def create_and_save_palette(self):
        """Extract colors from the image and save the palette as a PNG file."""
        if self.img is None:
            print("Please select an image first.")
            return
        num_colors = int(self.scale.get())
        rgb_colors_255 = self._extract_colors_kmeans(self.img, num_colors)
        sorted_rgb_01 = self._sort_colors_by_lab(rgb_colors_255)
        self._save_palette(sorted_rgb_01, num_colors)

    def _extract_colors_kmeans(self, image, num_colors):
        """
        Extract dominant colors using KMeans clustering.
        
        Args:
            image: PIL Image object
            num_colors: Number of colors to extract
            
        Returns:
            Array of RGB color values (0-255)
        """
        cpu_count = int(os.cpu_count() / 2)
        os.environ['LOKY_MAX_CPU_COUNT'] = str(cpu_count)
        
        img_small = image.resize((100, 100))
        pixels = np.array(img_small).reshape(-1, 3)
        kmeans = KMeans(n_clusters=num_colors, random_state=0, n_init=10).fit(pixels)
        return kmeans.cluster_centers_.astype(int)

    def _sort_colors_by_lab(self, rgb_colors_255):
        """
        Sort colors by perceptual similarity in LAB color space.
        
        Args:
            rgb_colors_255: Array of RGB colors (0-255)
            
        Returns:
            Array of sorted RGB colors (0-1)
        """
        lab_colors = [color.rgb2lab(np.array([[col/255.0]]))[0][0] for col in rgb_colors_255]
        lab_colors.sort(key=lambda x: x[0])
        
        sorted_lab_colors = [lab_colors.pop(0)]
        while lab_colors:
            last_color = sorted_lab_colors[-1]
            distances = [deltaE_ciede2000(last_color, lab_color) for lab_color in lab_colors]
            next_color_index = np.argmin(distances)
            sorted_lab_colors.append(lab_colors.pop(next_color_index))
            
        return [color.lab2rgb(np.array([[lab_col]]))[0][0] for lab_col in sorted_lab_colors]

    def _save_palette(self, sorted_colors, num_colors):
        """
        Create and save the color palette image.
        
        Args:
            sorted_colors: Array of RGB colors (0-1)
            num_colors: Number of colors in the palette
        """
        if self.file_path is None:
            print("Please select an image first.")
            return
        swatchsize = 3
        self.palette = Image.new('RGB', (swatchsize * num_colors, swatchsize))
        for i, col in enumerate(sorted_colors):
            col_int = tuple(map(lambda x: int(round(x * 255)), col))
            self.palette.paste(col_int, (i * swatchsize, 0, (i + 1) * swatchsize, swatchsize))
        file_name = os.path.splitext(os.path.basename(self.file_path))[0] + "_color_palette.png"
        save_file_path = filedialog.asksaveasfilename(defaultextension=".png", initialfile=file_name)
        if save_file_path:
            self.palette.save(save_file_path)

    def change_scale(self, delta):
        """
        Create a handler for changing the scale value with arrow keys.
        
        Args:
            delta: Amount to change the scale value
            
        Returns:
            Event handler function
        """
        def handler(event):
            current_value = self.scale.get()
            new_value = current_value + delta
            if self.scale.cget("from") <= new_value <= self.scale.cget("to"):
                self.scale.set(new_value)
            return "break"
        return handler

    def on_preview_close(self):
        """Handle the closing of the preview window."""
        if self.preview_window:
            self.preview_window.destroy()
        self.preview_window = None

    def preview_palette(self):
        """Generate and display a preview of the color palette, reusing the window and wrapping colors."""
        if self.img is None:
            print("Please select an image first.")
            return
        num_colors = int(self.scale.get())
        try:
            rgb_colors_255 = self._extract_colors_kmeans(self.img, num_colors)
            sorted_rgb_01 = self._sort_colors_by_lab(rgb_colors_255)
        except Exception as e:
            print(f"Error generating palette: {e}")
            tk.messagebox.showerror("Error", f"Could not generate palette.\n{e}")
            return
        
        MAX_PREVIEW_WIDTH = 512 # Max preview width
        SWATCH_WIDTH = 32
        SWATCH_HEIGHT = 32
        swatches_per_row = max(1, MAX_PREVIEW_WIDTH // SWATCH_WIDTH)
        num_rows = (num_colors + swatches_per_row - 1) // swatches_per_row
        actual_preview_width = min(MAX_PREVIEW_WIDTH, num_colors * SWATCH_WIDTH)
        if num_colors > 0:
            actual_preview_width = max(SWATCH_WIDTH, actual_preview_width)
        else:
            actual_preview_width = SWATCH_WIDTH
        preview_height = num_rows * SWATCH_HEIGHT
        if num_colors > 0:
             preview_height = max(SWATCH_HEIGHT, preview_height)
        else:
             preview_height = SWATCH_HEIGHT

        if self.preview_window and self.preview_window.winfo_exists():
            canvas = self.preview_window.winfo_children()[0]
            canvas.delete("all")
            self.preview_window.geometry(f"{actual_preview_width}x{preview_height}")
            canvas.config(width=actual_preview_width, height=preview_height)
            self.preview_window.lift()
            self.preview_window.focus_set()
        else:
            self.preview_window = Toplevel(self.root)
            self.preview_window.title("Palette Preview")
            self.preview_window.geometry(f"{actual_preview_width}x{preview_height}")
            self.preview_window.resizable(False, False)
            self.preview_window.transient(self.root)
            self.preview_window.protocol("WM_DELETE_WINDOW", self.on_preview_close)
            
            canvas = tk.Canvas(self.preview_window, width=actual_preview_width, height=preview_height, bd=0, highlightthickness=0)
            canvas.pack()
            self.root.update_idletasks()
            main_x = self.root.winfo_x()
            main_y = self.root.winfo_y()
            main_w = self.root.winfo_width()
            new_x = main_x + main_w + 5 # add small gap
            new_y = main_y
            self.preview_window.geometry(f'+{new_x}+{new_y}')
            self.preview_window.focus_set()

        canvas = self.preview_window.winfo_children()[0]
        for i, col_01 in enumerate(sorted_rgb_01):
            col_hex = '#{:02x}{:02x}{:02x}'.format(
                int(round(col_01[0] * 255)),
                int(round(col_01[1] * 255)),
                int(round(col_01[2] * 255))
            )
            row = i // swatches_per_row
            col = i % swatches_per_row
            x1 = col * SWATCH_WIDTH
            y1 = row * SWATCH_HEIGHT
            x2 = x1 + SWATCH_WIDTH
            y2 = y1 + SWATCH_HEIGHT
            canvas.create_rectangle(x1, y1, x2, y2, fill=col_hex, outline='')

def main():
    """Start the application."""
    root = tk.Tk()
    icon_data = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQBAMAAADt3eJSAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAeUExURRMDEB0FGCcHITwJIVILIH0PH6gUHdMYHP8lK////9UYX/kAAAABYktHRAnx2aXsAAAAB3RJTUUH5wQXAzoaJVbRJgAAAChJREFUCNdjYGBgFBQUUlJiIIZhbGzi4uIaGkoaIy0tvby8oqODGAYAKiohEXlZcJwAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjMtMDQtMjNUMDM6NTg6MjUrMDA6MDDuL0rHAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDIzLTA0LTIzVDAzOjU4OjI1KzAwOjAwn3LyewAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyMy0wNC0yM1QwMzo1ODoyNiswMDowMPmPyTkAAAAASUVORK5CYII="
    icon = tk.PhotoImage(data=icon_data)
    root.iconphoto(True, icon)
    app = Img2Palette(root)
    root.update_idletasks()
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    window_width = root.winfo_width()
    window_height = root.winfo_height()
    x = (screen_width // 2) - (window_width // 2)
    y = (screen_height // 2) - (window_height // 2)
    root.geometry(f'{window_width}x{window_height}+{x}+{y}')
    root.mainloop()

if __name__ == '__main__':
    main()
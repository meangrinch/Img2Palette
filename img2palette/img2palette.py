import tkinter as tk
from tkinter import filedialog, Frame, Label, Button, Scale, HORIZONTAL
from PIL import Image, ImageTk
from skimage import color
from skimage.color import deltaE_ciede2000
import numpy as np
import os

class Img2Palette:
    def __init__(self, root):
        self.root = root
        self.img = None
        self.palette = None
        self.file_path = None
        self.setup_ui()

    def setup_ui(self):
        self.root.title("Img2Palette")
        self.root.geometry("250x420")
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
        Button(self.root, text="Save Color Palette", command=self.create_and_save_palette).pack(pady=5)

    def get_image(self):
        self.file_path = filedialog.askopenfilename()
        if not self.file_path:
            return
        self.img = Image.open(self.file_path).convert('RGB')
        self.img.thumbnail((256, 256), Image.Resampling.LANCZOS)
        colors = np.array(self.img).reshape(-1, 3)
        max_colors = min(len(np.unique(colors, axis=0)), 256)
        self.scale.config(to=max_colors)
        self.img_preview = ImageTk.PhotoImage(self.img)
        self.img_label.config(image=self.img_preview)  # type: ignore

    def create_and_save_palette(self):
        if self.img is None:
            print("Please select an image first.")
            return
        num_colors = int(self.scale.get())
        quantized_img = self.img.resize((256, 256)).quantize(colors=num_colors).convert('RGB')
        lab_colors = self._sort_colors_by_lab(quantized_img.getcolors(num_colors))
        self._save_palette(lab_colors, num_colors)

    def _sort_colors_by_lab(self, colors):
        lab_colors = [color.rgb2lab(np.array([[col]])/255)[0][0] for count, col in colors]
        lab_colors.sort(key=lambda x: x[0])
        sorted_lab_colors = [lab_colors.pop(0)]
        while lab_colors:
            last_color = sorted_lab_colors[-1]
            distances = [deltaE_ciede2000(last_color, lab_color) for lab_color in lab_colors]
            next_color = lab_colors.pop(np.argmin(distances))
            sorted_lab_colors.append(next_color)
        return [color.lab2rgb(np.array([[lab_col]]))[0][0] for lab_col in sorted_lab_colors]

    def _save_palette(self, sorted_colors, num_colors):
        if self.file_path is None:
            print("Please select an image first.")
            return
        swatchsize = 3 # change this for output swatch size (px)
        self.palette = Image.new('RGB', (swatchsize * num_colors, swatchsize))
        for i, col in enumerate(sorted_colors):
            col_int = tuple(map(lambda x: int(round(x * 255)), col))
            self.palette.paste(col_int, (i * swatchsize, 0, (i + 1) * swatchsize, swatchsize))
        file_name = os.path.splitext(os.path.basename(self.file_path))[0] + "_color_palette.png"
        save_file_path = filedialog.asksaveasfilename(defaultextension=".png", initialfile=file_name)
        if save_file_path:
            self.palette.save(save_file_path)

    def change_scale(self, delta):
        def handler(event):
            current_value = self.scale.get()
            new_value = current_value + delta
            if self.scale.cget("from") <= new_value <= self.scale.cget("to"):
                self.scale.set(new_value)
            return "break"
        return handler

def main():
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
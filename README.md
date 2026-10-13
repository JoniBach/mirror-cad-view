# mirror-cad view

Opens a 3D model from a link and makes its print files (STL or 3MF) in the browser. The model travels in the link's
fragment (`#m=…`), which browsers never send to the web host: this page is public, the models are not.

- `…/#m=1.<data>` shows the model, turning (drag to turn it yourself), with its rules and print notes.
- The parts panel ticks which parts a download holds (all printed parts at first): STL as one mesh, 3MF in Bambu
  Studio's layout with an object per printed thing and each part on its AMS slot.
- `…&get=stl` or `…&get=3mf` downloads every printed part as soon as the page opens.

Links are made by mirror-cad (`cad link <project>/<object>`). The page reads data only, never code. Published from
mirror-cad's `view/` folder; changes made here are overwritten.

three.js (MIT, `three.LICENSE`) draws the model.

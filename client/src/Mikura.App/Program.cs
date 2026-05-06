using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.App.Ui;
using Mikura.App.Util;

namespace Mikura.App;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        FileLogger.Initialize();

        ApplicationConfiguration.Initialize();

        var settings = AppSettings.Load(args);

        using var context = new TrayAppContext(settings);
        Application.Run(context);
    }
}
